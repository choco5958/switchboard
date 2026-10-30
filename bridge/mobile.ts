// The phone page (bridge/mobile/): a small web app a phone on the same network, or on the
// person's Tailscale tailnet, opens to answer decisions and permission asks, see tasks and
// write to sessions. Off until the person turns it on in the app's settings.
//
// A phone opens it over plain HTTP (a browser has no HTTPS for an address like
// 192.168.0.5), so the page and this server encrypt every request and answer themselves
// (mobile/aead.js). Each phone gets its own key at pairing, in the QR code's fragment,
// which never goes over the network: someone listening on the Wi-Fi sees neither what was
// asked nor answered, and cannot answer in the person's place. A request carries its time
// and a nonce used once, so a recorded one cannot be sent again. Whoever controls the
// network could still serve another page in this one's place, so over plain HTTP a phone
// cannot allow a permission ask or write to a session (needsStrong): that takes Tailscale.
// The same goes for a phone whose key went out in a link to a plain HTTP address: a swapped
// page could have read it, so such a phone may not do either even when it later comes in
// over Tailscale (or Funnel, which anyone can reach). Only a phone paired through an HTTPS or
// Tailscale address, or with a code claimed over one, may.

import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { fromB64, fromUtf8, open, seal, toB64, utf8 } from './mobile/aead.js'
import { sendPush, validSubscription, type PushMessage, type Subscription, type VapidKeys } from './push.ts'

export const MOBILE_PORT = 47390
// How far a request's time may be from the bridge's (the page corrects its clock with GET /time).
const SKEW_MS = 2 * 60_000
// A phone's requests are small: a decision's memo or a message for a session, which the page
// caps at TEXT_MAX characters (mobile/app.js). Sealed and in base64, the largest is about 16 KB.
const API_MAX = 32 * 1024
const CLAIM_MAX = 1024
// A body has this long to arrive once its headers have: slow ones would hold the connections.
const BODY_MS = 5_000
const STATIC = join(dirname(fileURLToPath(import.meta.url)), 'mobile')
const FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/aead.js': ['aead.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.png': ['icon.png', 'image/png'],
}
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}

// What a phone may ask of the bridge: the same routes the app uses for these, nothing else.
export function mobileRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET') return path === '/mobile/view'
  return method === 'POST' && (/^\/questions\/\d+\/(answer|hold)$/.test(path) || /^\/approvals\/\d+\/answer$/.test(path) || path === '/outbox')
}

// Addresses a phone may come from: this computer, the private network, link-local and
// Tailscale (100.64.0.0/10). A computer with a public address answers no one out there.
export function privateAddress(raw: string): boolean {
  const address = raw.replace(/^::ffff:/, '')
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  const lower = address.toLowerCase()
  return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

// `name`: this Mac's Bonjour name, which stays when the router hands out another address.
// `https`: the Tailscale HTTPS address (tailscale serve), the one where notifications work.
export type MobileAddress = { address: string; kind: 'name' | 'lan' | 'tailscale' | 'https'; url: string }

// Where a phone can reach this computer, for the QR code: the HTTPS address first (when there
// is one), then the private IPv4 addresses, the Bonjour name and Tailscale's addresses. `lan` false: the
// page listens on this computer only, and Tailscale HTTPS is the one way in.
export function mobileAddresses(port: number, where: { interfaces?: ReturnType<typeof networkInterfaces>; name?: string | null; https?: string | null; lan?: boolean } = {}): MobileAddress[] {
  const found: MobileAddress[] = []
  if (where.https) found.push({ address: where.https, kind: 'https', url: `https://${where.https}` })
  if (where.lan === false) return found
  const ips: MobileAddress[] = []
  for (const list of Object.values(where.interfaces ?? networkInterfaces())) {
    for (const one of list ?? []) {
      if (one.family !== 'IPv4' || one.internal || !privateAddress(one.address) || one.address.startsWith('169.254.')) continue
      ips.push({ address: one.address, kind: one.address.startsWith('100.') ? 'tailscale' : 'lan', url: `http://${one.address}:${port}` })
    }
  }
  // The name after the Wi-Fi addresses: some networks and phones do not resolve .local names.
  const name: MobileAddress[] = where.name ? [{ address: where.name, kind: 'name', url: `http://${where.name}:${port}` }] : []
  const lanIps = ips.filter(a => a.kind === 'lan')
  return [...found, ...lanIps, ...name, ...ips.filter(a => a.kind === 'tailscale')]
}

// macOS's Bonjour name ("name.local"); other systems may not answer one, so none is offered there.
let bonjour: string | null | undefined
export function bonjourName(): string | null {
  if (bonjour !== undefined) return bonjour
  bonjour = null
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'LocalHostName'], { timeout: 2000, encoding: 'utf8' }).trim()
      if (/^[A-Za-z0-9-]{1,63}$/.test(name)) bonjour = `${name}.local`
    } catch {
      // No name set.
    }
  }
  return bonjour
}

// --- Tailscale HTTPS (tailscale serve): an HTTPS address on the person's own tailnet ---

export type Run = (file: string, args: string[]) => Promise<{ ok: boolean; out: string }>
const runFile: Run = (file, args) =>
  new Promise(resolve => execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(error ? stderr || error.message : stdout) })))

// The app's own PATH is the system's, without Homebrew or /usr/local: look there too.
export function tailscaleBin(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
      : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  return candidates.find(path => existsSync(path)) ?? null
}

export type TailscaleState = {
  installed: boolean
  domain: string
  served: boolean
  busy: boolean
  // Tailscale Funnel: the same HTTPS address open to the whole internet, so a phone without
  // Tailscale reaches it over any network. `funnelAllowed`: the tailnet lets this computer use
  // it (an admin turns it on once, at `funnelLink`).
  funnel: boolean
  funnelAllowed: boolean
  funnelLink: string
}

const NO_TAILSCALE = { domain: '', served: false, busy: false, funnel: false, funnelAllowed: false, funnelLink: '' }

// `served`: tailscale serve sends https://<domain>/ to this port. `busy`: port 443 already goes
// somewhere else, which turning it on would replace, so the app leaves it alone.
export async function tailscaleState(port: number, run: Run = runFile, bin = tailscaleBin()): Promise<TailscaleState> {
  if (!bin) return { installed: false, ...NO_TAILSCALE }
  const status = await run(bin, ['status', '--json'])
  let domain = ''
  let funnelAllowed = false
  let node = ''
  try {
    const parsed = JSON.parse(status.out) as { BackendState?: string; CertDomains?: string[]; Self?: { ID?: string; CapMap?: Record<string, unknown> } }
    if (parsed.BackendState === 'Running') domain = parsed.CertDomains?.[0] ?? ''
    funnelAllowed = Object.hasOwn(parsed.Self?.CapMap ?? {}, 'funnel')
    node = typeof parsed.Self?.ID === 'string' ? parsed.Self.ID : ''
  } catch {
    // Not logged in, or not running.
  }
  if (!domain) return { installed: true, ...NO_TAILSCALE }
  const funnelLink = node ? `https://login.tailscale.com/f/funnel?node=${encodeURIComponent(node)}` : 'https://login.tailscale.com/admin/acls'
  const serve = await run(bin, ['serve', 'status', '--json'])
  let handlers: Record<string, { Proxy?: string }> = {}
  let any443 = false
  let funnel = false
  try {
    const parsed = JSON.parse(serve.out || '{}') as {
      TCP?: Record<string, unknown>
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      AllowFunnel?: Record<string, boolean>
    }
    any443 = Boolean(parsed.TCP?.['443'])
    handlers = parsed.Web?.[`${domain}:443`]?.Handlers ?? {}
    funnel = parsed.AllowFunnel?.[`${domain}:443`] === true
  } catch {
    // No serve config.
  }
  const mine = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}/?$`)
  const served = port > 0 && mine.test(handlers['/']?.Proxy ?? '')
  return { installed: true, domain, served, busy: any443 && !served, funnel: served && funnel, funnelAllowed, funnelLink }
}

// `funnel` true opens the address to the internet; false keeps it on the tailnet (serve turns a
// funnel on that port off). Off goes through serve too: `tailscale funnel ... off` waits forever
// on a tailnet that does not allow Funnel.
export async function setTailscaleServe(on: boolean, port: number, run: Run = runFile, bin = tailscaleBin(), funnel = false): Promise<{ ok: boolean; error: string }> {
  if (!bin) return { ok: false, error: 'tailscale' }
  const target = `http://127.0.0.1:${port}`
  const result = !on
    ? await run(bin, ['serve', '--https=443', 'off'])
    : await run(bin, [funnel ? 'funnel' : 'serve', '--bg', '--https=443', target])
  return { ok: result.ok, error: result.ok ? '' : result.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) }
}

export type Inner = (method: string, path: string, body: unknown) => Promise<{ status: number; json: unknown }>
// `strong`: paired through an HTTPS or Tailscale address, so it may allow and write (needsStrong).
// `code`: its pairing code still works.
export type Device = { id: number; name: string; created_at: number; last_seen: number | null; strong: boolean; code: boolean }
export type MobileStatus = { listening: boolean; port: number; error: string; lan: boolean; addresses: MobileAddress[]; devices: Device[]; tailscale: TailscaleState }

// A sealed message's JSON, or null.
function parsed<T>(bytes: Uint8Array): T | null {
  try {
    const value = JSON.parse(fromUtf8(bytes)) as unknown
    return value !== null && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}

const reqAad = (device: number) => utf8(`sb1:req:${device}`)
const resAad = (device: number, nonce: string) => utf8(`sb1:res:${device}:${nonce}`)
const eventsAad = (device: number) => utf8(`sb1:ev:${device}`)

// 12 bytes in base64url: no other spelling of the same nonce gets through.
const NONCE = /^[A-Za-z0-9_-]{16}$/
const SEALED = /^[A-Za-z0-9_-]{22,}$/
// Failed requests one address may send in a minute before it waits out the rest of it.
const FAIL_MAX = 30
const STREAMS_PER_DEVICE = 3
// Senders whose failures are kept; past it old counts go, never all at once (that would unblock everyone).
const FAIL_SENDERS = 1000
// Requests one sender may have open at once, live streams included (a page holds one or two).
const OPEN_PER_SENDER = 8
// Connections one address on the network may hold, before it sends a request at all.
const SOCKETS_PER_ADDRESS = 16
// Pairing codes tried in a minute, by one sender and by everyone: guessing one of 32^8 stays hopeless.
const CLAIMS_PER_SENDER = 5
const CLAIMS_PER_MINUTE = 30
// How often the Tailscale name is looked up again, for the Host check (never on a request).
const DOMAIN_MS = 5 * 60_000
// A phone paired with the QR code or the code has this long to come once; after that the pairing goes.
const PAIR_MS = 10 * 60_000
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// A request whose page cannot have been swapped on the way: it came through Tailscale HTTPS
// (which forwards from this computer) or over Tailscale itself (WireGuard). Plain HTTP on the
// Wi-Fi is encrypted by the page, but whoever controls that network can serve another page.
export function strongTransport(raw: string): boolean {
  const address = raw.replace(/^::ffff:/, '').toLowerCase()
  const v4 = address.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) return Number(v4[1]) === 127 || (Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127)
  return address === '::1' || address.startsWith('fd7a:115c:a1e0:')
}

// What only a phone on such a connection may do: allow a permission ask, and write to a session.
export function needsStrong(method: string, path: string, body: unknown): boolean {
  if (method !== 'POST') return false
  if (path === '/outbox') return true
  return /^\/approvals\/\d+\/answer$/.test(path) && (body as { decision?: unknown } | null)?.decision === 'allow'
}

// Who sent a request, for the failure count. Tailscale HTTPS and Funnel forward every phone from
// this computer and name the real sender in X-Forwarded-For; counting by 127.0.0.1 would let one
// stranger's bad requests shut every phone out.
export function clientOf(address: string, forwarded: string | string[] | undefined): string {
  const loopback = /^(::ffff:)?127\./.test(address) || address === '::1'
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return loopback && first ? first : address
}

// The key failures and limits are counted under: an IPv6 sender by its /64, which one home or
// phone holds whole (counting each address alone would let it go on under the next one).
export function rateKey(address: string): string {
  const plain = address.replace(/^::ffff:(?=\d+\.)/i, '').split('%')[0]!.toLowerCase()
  if (!plain.includes(':')) return plain
  const [head = '', tail = ''] = plain.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = plain.includes('::') ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

// At most `max` per key in a minute: true while under it (each call counts).
function perMinute(max: number, now: () => number): (key: string) => boolean {
  const counts = new Map<string, { count: number; since: number }>()
  return key => {
    let entry = counts.get(key)
    if (!entry || now() - entry.since > 60_000) {
      counts.delete(key)
      entry = { count: 0, since: now() }
      counts.set(key, entry)
    }
    while (counts.size > FAIL_SENDERS) counts.delete(counts.keys().next().value!)
    return ++entry.count <= max
  }
}

export function newPairCode(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, b => CODE_LETTERS[b % CODE_LETTERS.length]).join('')
}

export function createMobile(options: {
  db: DatabaseSync
  inner: Inner
  strings: () => Record<string, string>
  vapid: () => VapidKeys
  now?: () => number
  fetch?: typeof fetch
  run?: Run
  tailscale?: string | null
  // Something the app shows changed: a code was used, a phone came for the first time.
  changed?: () => void
  // How long a body may take (BODY_MS), shorter in tests.
  bodyMs?: number
}) {
  const { db } = options
  const now = options.now ?? Date.now
  // A request older than this bridge may be one sent before a restart, whose nonce it no longer knows.
  const startedAt = now()
  const bodyMs = options.bodyMs ?? BODY_MS
  db.exec(`create table if not exists mobile_devices (
    id integer primary key, name text not null, key text not null,
    created_at integer not null, last_seen integer
  )`)
  // The phone's Web Push subscription (push.ts), when it turned notifications on.
  // `strong`: how it was paired (Device). Phones paired before it was kept count as plain HTTP.
  const have = (db.prepare('pragma table_info(mobile_devices)').all() as { name: string }[]).map(c => c.name)
  for (const [name, type] of [['push', 'text'], ['strong', 'integer not null default 0']]) if (!have.includes(name!)) db.exec(`alter table mobile_devices add column ${name} ${type}`)
  // Nonces seen in the last SKEW_MS, per phone: a request sent again is refused.
  const seen = new Map<number, Map<string, number>>()
  const streams = new Set<{ res: ServerResponse; device: number }>()
  // Failed requests by address, for FAIL_MAX.
  const failures = new Map<string, { count: number; since: number }>()
  // Requests open per sender, and connections per network address (OPEN_PER_SENDER, SOCKETS_PER_ADDRESS).
  const openRequests = new Map<string, number>()
  const sockets = new Map<string, number>()
  const claimsBy = perMinute(CLAIMS_PER_SENDER, now)
  const claimsAll = perMinute(CLAIMS_PER_MINUTE, now)
  // Pairing codes for a phone that cannot scan into the browser it will use (an iPhone's home
  // screen app keeps its own storage): code -> device, until it is used, its phone comes with
  // the QR code instead, or PAIR_MS passes.
  const codes = new Map<string, { device: number; until: number }>()
  // A stream can end before its 'close' arrives: a write then would throw and take the bridge down.
  const ping = (res: ServerResponse, text: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(text)
  }
  const endStream = (stream: { res: ServerResponse; device: number }) => {
    streams.delete(stream)
    stream.res.end()
  }
  let server: Server | null = null
  let port = 0
  let lan = true
  let error = ''
  // The Tailscale HTTPS name, for the Host check: known from the last look at Tailscale.
  let httpsDomain = ''
  let domainTimer: ReturnType<typeof setInterval> | undefined
  const run = options.run ?? runFile
  const tailscaleAt = options.tailscale === undefined ? tailscaleBin() : options.tailscale

  // Pairings nobody used within PAIR_MS, and their codes, go.
  const prune = () => {
    db.prepare('delete from mobile_devices where last_seen is null and created_at < ?').run(now() - PAIR_MS)
    for (const [code, entry] of codes) if (entry.until < now()) codes.delete(code)
  }
  const keyOf = (id: number): Uint8Array | null => {
    const row = db.prepare('select key from mobile_devices where id = ?').get(id) as { key: string } | undefined
    return row ? fromB64(row.key) : null
  }
  const strongDevice = (id: number): boolean => (db.prepare('select strong from mobile_devices where id = ?').get(id) as { strong: number } | undefined)?.strong === 1
  const devices = (): Device[] =>
    (db.prepare('select id, name, created_at, last_seen, strong from mobile_devices order by id').all() as (Omit<Device, 'strong' | 'code'> & { strong: number })[]).map(d => ({
      ...d,
      strong: d.strong === 1,
      code: [...codes.values()].some(entry => entry.device === d.id),
    }))
  // A phone proved it holds its key: its code goes, so nobody can claim the same key later.
  const arrived = (device: number) => {
    const first = db.prepare('update mobile_devices set last_seen = ? where id = ? and last_seen is null').run(now(), device).changes > 0
    if (!first) db.prepare('update mobile_devices set last_seen = ? where id = ?').run(now(), device)
    for (const [code, entry] of codes) if (entry.device === device) codes.delete(code)
    if (first) options.changed?.()
  }

  const fresh = (device: number, nonce: string, at: number): boolean => {
    const list = seen.get(device) ?? new Map<string, number>()
    for (const [n, t] of list) if (now() - t > SKEW_MS * 2) list.delete(n)
    seen.set(device, list)
    if (!Number.isFinite(at) || at < startedAt || Math.abs(now() - at) > SKEW_MS || list.has(nonce)) return false
    list.set(nonce, now())
    return true
  }

  const blocked = (address: string) => {
    const entry = failures.get(address)
    if (entry && now() - entry.since > 60_000) failures.delete(address)
    return (failures.get(address)?.count ?? 0) >= FAIL_MAX
  }
  const failed = (address: string) => {
    const entry = failures.get(address) ?? { count: 0, since: now() }
    entry.count++
    failures.set(address, entry)
    if (failures.size <= FAIL_SENDERS) return
    for (const [key, old] of failures) if (now() - old.since > 60_000) failures.delete(key)
    // Still too many: the oldest count that blocks nobody goes (a Map keeps the order counts began
    // in), so a crowd of new senders never sets a blocked one free.
    while (failures.size > FAIL_SENDERS) {
      let drop = failures.keys().next().value!
      for (const [key, old] of failures) {
        if (old.count < FAIL_MAX) {
          drop = key
          break
        }
      }
      failures.delete(drop)
    }
  }

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  // A body larger than `max` is refused by its declared length before any of it is read.
  const tooLarge = (req: IncomingMessage, max: number) => Number(req.headers['content-length'] ?? 0) > max
  const readBody = async (req: IncomingMessage, max: number): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    const deadline = setTimeout(() => req.destroy(new Error('too slow')), bodyMs)
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > max) {
          req.destroy()
          throw new Error('too large')
        }
        chunks.push(chunk as Buffer)
      }
    } finally {
      clearTimeout(deadline)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  // Opens a sealed {d, n, c}: the device, its key and the plaintext, or null.
  const unseal = (d: unknown, n: unknown, c: unknown, aad: (device: number) => Uint8Array): { device: number; key: Uint8Array; plain: Uint8Array } | null => {
    const device = Number(d)
    if (!Number.isInteger(device) || typeof n !== 'string' || typeof c !== 'string' || !NONCE.test(n) || !SEALED.test(c)) return null
    const key = keyOf(device)
    if (!key) return null
    const plain = open(key, fromB64(n), fromB64(c), aad(device))
    return plain ? { device, key, plain } : null
  }

  // This phone's own notifications: the bridge's public VAPID key, and turning them on or off.
  function pushRoute(device: number, method: string, path: string, body: unknown): { status: number; json: unknown } {
    if (method === 'GET' && path === '/push-key') return { status: 200, json: { key: options.vapid().publicKey } }
    if (method !== 'POST') return { status: 403, json: { error: 'not allowed' } }
    const subscription = (body as { subscription?: unknown } | null)?.subscription ?? null
    if (subscription !== null && !validSubscription(subscription)) return { status: 400, json: { error: 'not a push subscription' } }
    db.prepare('update mobile_devices set push = ? where id = ?').run(subscription === null ? null : JSON.stringify(subscription), device)
    return { status: 200, json: { on: subscription !== null } }
  }

  async function api(req: IncomingMessage, res: ServerResponse, address: string, who: string): Promise<void> {
    let outer: { d?: unknown; n?: unknown; c?: unknown }
    if (tooLarge(req, API_MAX)) {
      failed(who)
      res.shouldKeepAlive = false
      return reply(res, 413, { error: 'too large' })
    }
    try {
      outer = JSON.parse(await readBody(req, API_MAX)) as typeof outer
    } catch {
      failed(who)
      return reply(res, 400, { error: 'bad request' })
    }
    // Requests sent together are counted only as each fails: stop opening them once blocked.
    if (blocked(who)) return reply(res, 429, { error: 'too many failed requests' })
    const opened = unseal(outer.d, outer.n, outer.c, reqAad)
    const inner = opened ? parsed<{ t?: unknown; method?: unknown; path?: unknown; body?: unknown }>(opened.plain) : null
    if (!opened || !inner) {
      failed(who)
      return reply(res, 401, { error: 'unknown device' })
    }
    const { device, key } = opened
    const nonce = String(outer.n)
    if (!fresh(device, nonce, Number(inner.t))) return reply(res, 409, { error: 'clock', now: now() })
    arrived(device)
    const method = String(inner.method)
    const path = String(inner.path)
    const body = inner.body ?? {}
    // `pairAgain`: the connection is fine, but this phone was paired over plain HTTP.
    let result =
      path === '/push-key' || path === '/push'
        ? pushRoute(device, method, path, body)
        : !mobileRouteAllowed(method, path)
          ? { status: 403, json: { error: 'not allowed' } }
          : needsStrong(method, path, body) && !(strongTransport(address) && strongDevice(device))
            ? { status: 403, json: { error: 'strong', strong: true, pairAgain: strongTransport(address) } }
            : await options.inner(method, path, body)
    // The page shows what this phone may do before it tries.
    if (method === 'GET' && path === '/mobile/view' && result.status === 200 && result.json !== null && typeof result.json === 'object') {
      result = { ...result, json: { ...result.json, pairedStrong: strongDevice(device) } }
    }
    const answerNonce = randomBytes(12)
    const sealed = seal(key, answerNonce, utf8(JSON.stringify(result)), resAad(device, nonce))
    return reply(res, 200, { n: toB64(answerNonce), c: toB64(sealed) })
  }

  // Names this server answers to: an address, this Mac's Bonjour name, the Tailscale HTTPS
  // name, localhost. A page that rebinds a name of its own to this computer sends that name.
  const hostAllowed = (host: string | undefined): boolean => {
    const name = (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
    if (!name) return false
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':')) return privateAddress(name)
    return name === 'localhost' || name === bonjourName()?.toLowerCase() || (httpsDomain !== '' && name === httpsDomain.toLowerCase())
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? ''
    if (!privateAddress(address)) return reply(res, 403, { error: 'forbidden' })
    const who = rateKey(clientOf(address, req.headers['x-forwarded-for']))
    if (blocked(who)) return reply(res, 429, { error: 'too many failed requests' })
    // The Tailscale name is known from status() and a timer: a request never runs a command.
    if (!hostAllowed(req.headers.host)) {
      failed(who)
      return reply(res, 403, { error: 'forbidden' })
    }
    // Slow requests from one sender (through Funnel, all from 127.0.0.1) would hold every connection.
    const already = openRequests.get(who) ?? 0
    if (already >= OPEN_PER_SENDER) {
      res.shouldKeepAlive = false
      return reply(res, 429, { error: 'too many requests' })
    }
    openRequests.set(who, already + 1)
    res.once('close', () => {
      const left = (openRequests.get(who) ?? 1) - 1
      if (left > 0) openRequests.set(who, left)
      else openRequests.delete(who)
    })
    const url = new URL(req.url ?? '/', 'http://phone')
    const method = req.method ?? 'GET'
    const file = FILES[url.pathname]
    if (method === 'GET' && file) {
      res.writeHead(200, { ...HEADERS, 'content-type': file[1] })
      return void res.end(readFileSync(join(STATIC, file[0])))
    }
    if (method === 'GET' && url.pathname === '/time') return reply(res, 200, { now: now() })
    // The page's words, in the app's language (no secret in them).
    if (method === 'GET' && url.pathname === '/strings') return reply(res, 200, options.strings())
    // Only that something changed, never what: the page then asks for the view. The query carries
    // a sealed time, so only a paired phone opens one, and each link opens one stream.
    if (method === 'GET' && url.pathname === '/events') {
      const opened = unseal(url.searchParams.get('d'), url.searchParams.get('n'), url.searchParams.get('c'), eventsAad)
      const at = opened ? Number(parsed<{ t?: unknown }>(opened.plain)?.t) : NaN
      if (!opened || !fresh(opened.device, String(url.searchParams.get('n')), at)) {
        failed(who)
        return reply(res, 401, { error: 'unknown device' })
      }
      arrived(opened.device)
      const mine = [...streams].filter(s => s.device === opened.device)
      for (const old of mine.slice(0, Math.max(0, mine.length - STREAMS_PER_DEVICE + 1))) endStream(old)
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
      res.write(': connected\n\n')
      const stream = { res, device: opened.device }
      streams.add(stream)
      const beat = setInterval(() => ping(res, ': beat\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(beat)
        streams.delete(stream)
      })
      return
    }
    // A pairing code typed on the phone: over a connection where the answer cannot be read on the way.
    // Tries are limited per sender and for everyone, and a wrong one never takes anyone else's code.
    if (method === 'POST' && url.pathname === '/claim') {
      if (!strongTransport(address)) return reply(res, 403, { error: 'strong', strong: true })
      if (!claimsBy(who) || !claimsAll('')) return reply(res, 429, { error: 'too many codes' })
      if (tooLarge(req, CLAIM_MAX)) {
        failed(who)
        res.shouldKeepAlive = false
        return reply(res, 413, { error: 'too large' })
      }
      let code = ''
      try {
        code = String((JSON.parse(await readBody(req, CLAIM_MAX)) as { code?: unknown }).code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      } catch {
        code = ''
      }
      prune()
      const entry = codes.get(code)
      if (entry) codes.delete(code)
      const row = entry ? (db.prepare('select last_seen from mobile_devices where id = ?').get(entry.device) as { last_seen: number | null } | undefined) : undefined
      // A phone already came with the QR code: its key is in use, and stays with that phone.
      if (!entry || !row || row.last_seen !== null) {
        failed(who)
        return reply(res, 404, { error: 'no such code' })
      }
      // A new key, handed over this connection only: the one in the QR code may have gone out in a
      // link to a plain HTTP address, and must not become one that may allow.
      const key = toB64(randomBytes(32))
      db.prepare('update mobile_devices set key = ?, strong = 1 where id = ?').run(key, entry.device)
      seen.delete(entry.device)
      options.changed?.()
      return reply(res, 200, { id: entry.device, key })
    }
    if (method === 'POST' && url.pathname === '/api') return api(req, res, address, who)
    return reply(res, 404, { error: 'not found' })
  }

  const stopNow = (): Promise<void> =>
    new Promise(resolve => {
      clearInterval(domainTimer)
      for (const s of [...streams]) endStream(s)
      if (!server) return resolve()
      const closing = server
      server = null
      port = 0
      closing.closeAllConnections()
      closing.close(() => resolve())
    })

  const startNow = async (wanted: number, overLan: boolean): Promise<void> => {
    await stopNow()
    error = ''
    lan = overLan
    // Headers and the whole request arrive within seconds, checked every second (the default
    // check every 30 s would let a slow sender hold a connection that long).
    const next = createServer({ headersTimeout: 5_000, requestTimeout: 10_000, connectionsCheckingInterval: 1_000 }, (req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 400, { error: 'bad request' })
        else res.end()
      })
    })
    next.maxConnections = 64
    // One address on the network holding many connections. Not 127.0.0.1: Tailscale HTTPS brings
    // every phone from there, and its requests are counted per sender in handle().
    next.on('connection', socket => {
      const raw = socket.remoteAddress ?? ''
      if (/^(::ffff:)?127\./.test(raw) || raw === '::1') return
      const from = rateKey(raw)
      const count = (sockets.get(from) ?? 0) + 1
      if (count > SOCKETS_PER_ADDRESS) return void socket.destroy()
      sockets.set(from, count)
      socket.once('close', () => {
        const left = (sockets.get(from) ?? 1) - 1
        if (left > 0) sockets.set(from, left)
        else sockets.delete(from)
      })
    })
    await new Promise<void>(resolve => {
      next.once('error', (e: NodeJS.ErrnoException) => {
        error = e.code === 'EADDRINUSE' ? `port ${wanted} is in use` : e.message
        resolve()
      })
      // This computer only, when the phone comes through Tailscale HTTPS (which forwards to 127.0.0.1).
      next.listen(wanted, overLan ? '0.0.0.0' : '127.0.0.1', () => {
        server = next
        const where = next.address()
        port = typeof where === 'object' && where ? where.port : wanted
        resolve()
      })
    })
    if (!server) return
    const lookUp = async () => {
      httpsDomain = (await tailscaleState(port, run, tailscaleAt)).domain
    }
    await lookUp()
    domainTimer = setInterval(() => void lookUp().catch(() => {}), DOMAIN_MS)
    domainTimer.unref()
  }

  // Starting and stopping run one after another: two quick toggles never race for the port.
  let queue: Promise<void> = Promise.resolve()
  const queued = (step: () => Promise<void>): Promise<void> => (queue = queue.then(step, step))

  return {
    start: (wanted: number, overLan = true) => queued(() => startNow(wanted, overLan)),
    stop: () => queued(stopNow),
    status: async (): Promise<MobileStatus> => {
      await queue
      prune()
      const tailscale = await tailscaleState(port, run, tailscaleAt)
      if (tailscale.domain) httpsDomain = tailscale.domain
      const addresses = server ? mobileAddresses(port, { name: bonjourName(), https: tailscale.served ? tailscale.domain : null, lan }) : []
      return { listening: server !== null, port, error, lan, addresses, devices: devices(), tailscale }
    },
    tailscale: (on: boolean, funnel = false) => setTailscaleServe(on, port, run, tailscaleAt, funnel),
    // A new phone: its id and key go into the QR code the app shows once, and a code for a
    // phone that types it instead. `kind`: the address the QR code links to; only an HTTPS or
    // Tailscale one keeps the key off a network where the page could be swapped.
    pair: (name: string, kind: MobileAddress['kind'] = 'lan'): { id: number; key: string; code: string } => {
      prune()
      const key = toB64(randomBytes(32))
      const strong = kind === 'https' || kind === 'tailscale' ? 1 : 0
      const id = Number(
        db.prepare('insert into mobile_devices (name, key, created_at, strong) values (?, ?, ?, ?)').run(name.slice(0, 60) || 'phone', key, now(), strong).lastInsertRowid,
      )
      const code = newPairCode()
      codes.set(code, { device: id, until: now() + PAIR_MS })
      return { id, key, code }
    },
    revoke: (id: number): boolean => {
      const removed = db.prepare('delete from mobile_devices where id = ?').run(id).changes > 0
      seen.delete(id)
      for (const [code, entry] of codes) if (entry.device === id) codes.delete(code)
      for (const s of [...streams]) if (s.device === id) endStream(s)
      return removed
    },
    changed: () => {
      for (const s of streams) ping(s.res, 'event: changed\ndata: {}\n\n')
    },
    // A notification to every phone that turned them on, while phones are on; one its push
    // service forgot is dropped.
    notify: async (message: PushMessage): Promise<number> => {
      if (!server) return 0
      const rows = db.prepare('select id, push from mobile_devices where push is not null').all() as { id: number; push: string }[]
      let sent = 0
      for (const row of rows) {
        const result = await sendPush(JSON.parse(row.push) as Subscription, message, options.vapid(), options.fetch ?? fetch)
        if (result.gone) db.prepare('update mobile_devices set push = null where id = ?').run(row.id)
        if (result.ok) sent++
      }
      return sent
    },
  }
}
