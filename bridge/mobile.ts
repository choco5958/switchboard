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
// A phone's requests are small: a decision's memo, a message for a session.
const BODY_MAX = 64 * 1024
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

export type TailscaleState = { installed: boolean; domain: string; served: boolean; busy: boolean }

// `served`: tailscale serve sends https://<domain>/ to this port. `busy`: port 443 already goes
// somewhere else, which turning it on would replace, so the app leaves it alone.
export async function tailscaleState(port: number, run: Run = runFile, bin = tailscaleBin()): Promise<TailscaleState> {
  if (!bin) return { installed: false, domain: '', served: false, busy: false }
  const status = await run(bin, ['status', '--json'])
  let domain = ''
  try {
    const parsed = JSON.parse(status.out) as { BackendState?: string; CertDomains?: string[] }
    if (parsed.BackendState === 'Running') domain = parsed.CertDomains?.[0] ?? ''
  } catch {
    // Not logged in, or not running.
  }
  if (!domain) return { installed: true, domain: '', served: false, busy: false }
  const serve = await run(bin, ['serve', 'status', '--json'])
  let handlers: Record<string, { Proxy?: string }> = {}
  let any443 = false
  try {
    const parsed = JSON.parse(serve.out || '{}') as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
    any443 = Boolean(parsed.TCP?.['443'])
    handlers = parsed.Web?.[`${domain}:443`]?.Handlers ?? {}
  } catch {
    // No serve config.
  }
  const mine = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}/?$`)
  const served = port > 0 && mine.test(handlers['/']?.Proxy ?? '')
  return { installed: true, domain, served, busy: any443 && !served }
}

export async function setTailscaleServe(on: boolean, port: number, run: Run = runFile, bin = tailscaleBin()): Promise<{ ok: boolean; error: string }> {
  if (!bin) return { ok: false, error: 'tailscale' }
  const result = on ? await run(bin, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]) : await run(bin, ['serve', '--https=443', 'off'])
  return { ok: result.ok, error: result.ok ? '' : result.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) }
}

export type Inner = (method: string, path: string, body: unknown) => Promise<{ status: number; json: unknown }>
export type Device = { id: number; name: string; created_at: number; last_seen: number | null }
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
// A phone paired with the QR code or the code has this long to come once; after that the pairing goes.
const PAIR_MS = 10 * 60_000
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_TRIES = 10

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
}) {
  const { db } = options
  const now = options.now ?? Date.now
  db.exec(`create table if not exists mobile_devices (
    id integer primary key, name text not null, key text not null,
    created_at integer not null, last_seen integer
  )`)
  // The phone's Web Push subscription (push.ts), when it turned notifications on.
  if (!(db.prepare('pragma table_info(mobile_devices)').all() as { name: string }[]).some(c => c.name === 'push')) db.exec('alter table mobile_devices add column push text')
  // Nonces seen in the last SKEW_MS, per phone: a request sent again is refused.
  const seen = new Map<number, Map<string, number>>()
  const streams = new Set<{ res: ServerResponse; device: number }>()
  // Failed requests by address, for FAIL_MAX.
  const failures = new Map<string, { count: number; since: number }>()
  // Pairing codes for a phone that cannot scan into the browser it will use (an iPhone's home
  // screen app keeps its own storage): code -> device, until it is used or PAIR_MS passes.
  const codes = new Map<string, { device: number; until: number }>()
  let codeMisses = 0
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
  const devices = (): Device[] => db.prepare('select id, name, created_at, last_seen from mobile_devices order by id').all() as Device[]

  const fresh = (device: number, nonce: string, at: number): boolean => {
    const list = seen.get(device) ?? new Map<string, number>()
    for (const [n, t] of list) if (now() - t > SKEW_MS * 2) list.delete(n)
    seen.set(device, list)
    if (!Number.isFinite(at) || Math.abs(now() - at) > SKEW_MS || list.has(nonce)) return false
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
    if (failures.size > 1000) failures.clear()
  }

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > BODY_MAX) {
        req.destroy()
        throw new Error('too large')
      }
      chunks.push(chunk as Buffer)
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

  async function api(req: IncomingMessage, res: ServerResponse, address: string): Promise<void> {
    let outer: { d?: unknown; n?: unknown; c?: unknown }
    try {
      outer = JSON.parse(await readBody(req)) as typeof outer
    } catch {
      failed(address)
      return reply(res, 400, { error: 'bad request' })
    }
    const opened = unseal(outer.d, outer.n, outer.c, reqAad)
    const inner = opened ? parsed<{ t?: unknown; method?: unknown; path?: unknown; body?: unknown }>(opened.plain) : null
    if (!opened || !inner) {
      failed(address)
      return reply(res, 401, { error: 'unknown device' })
    }
    const { device, key } = opened
    const nonce = String(outer.n)
    if (!fresh(device, nonce, Number(inner.t))) return reply(res, 409, { error: 'clock', now: now() })
    db.prepare('update mobile_devices set last_seen = ? where id = ?').run(now(), device)
    const method = String(inner.method)
    const path = String(inner.path)
    const body = inner.body ?? {}
    const result =
      path === '/push-key' || path === '/push'
        ? pushRoute(device, method, path, body)
        : !mobileRouteAllowed(method, path)
          ? { status: 403, json: { error: 'not allowed' } }
          : needsStrong(method, path, body) && !strongTransport(address)
            ? { status: 403, json: { error: 'strong', strong: true } }
            : await options.inner(method, path, body)
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
    if (!hostAllowed(req.headers.host)) {
      // The Tailscale name may be new since the last look.
      if ((req.headers.host ?? '').endsWith('.ts.net')) httpsDomain = (await tailscaleState(port, run, tailscaleAt)).domain
      if (!hostAllowed(req.headers.host)) return reply(res, 403, { error: 'forbidden' })
    }
    if (blocked(address)) return reply(res, 429, { error: 'too many failed requests' })
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
        failed(address)
        return reply(res, 401, { error: 'unknown device' })
      }
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
    if (method === 'POST' && url.pathname === '/claim') {
      if (!strongTransport(address)) return reply(res, 403, { error: 'strong', strong: true })
      let code = ''
      try {
        code = String((JSON.parse(await readBody(req)) as { code?: unknown }).code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      } catch {
        code = ''
      }
      prune()
      const entry = codes.get(code)
      if (!entry) {
        failed(address)
        // Too many wrong codes: every open code goes, and the app shows a new one.
        if (++codeMisses >= CODE_TRIES) {
          codes.clear()
          codeMisses = 0
        }
        return reply(res, 404, { error: 'no such code' })
      }
      codes.delete(code)
      const row = db.prepare('select key from mobile_devices where id = ?').get(entry.device) as { key: string } | undefined
      if (!row) return reply(res, 404, { error: 'no such code' })
      return reply(res, 200, { id: entry.device, key: row.key })
    }
    if (method === 'POST' && url.pathname === '/api') return api(req, res, address)
    return reply(res, 404, { error: 'not found' })
  }

  const stopNow = (): Promise<void> =>
    new Promise(resolve => {
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
    const next = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 400, { error: 'bad request' })
        else res.end()
      })
    })
    next.maxConnections = 64
    next.requestTimeout = 15_000
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
    if (server) httpsDomain = (await tailscaleState(port, run, tailscaleAt)).domain
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
    tailscale: (on: boolean) => setTailscaleServe(on, port, run, tailscaleAt),
    // A new phone: its id and key go into the QR code the app shows once, and a code for a
    // phone that types it instead.
    pair: (name: string): { id: number; key: string; code: string } => {
      prune()
      const key = toB64(randomBytes(32))
      const id = Number(db.prepare('insert into mobile_devices (name, key, created_at) values (?, ?, ?)').run(name.slice(0, 60) || 'phone', key, now()).lastInsertRowid)
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
