// The phone page (bridge/mobile/): a small web app a phone on the same network, or on the
// person's Tailscale tailnet, opens to answer decisions and permission asks, see tasks and
// write to sessions. Off until the person turns it on in the app's settings.
//
// A phone opens it over plain HTTP (a browser has no HTTPS for an address like
// 192.168.0.5), so the page and this server encrypt every request and answer themselves
// (mobile/aead.js). Each phone gets its own key at pairing, in the QR code's fragment,
// which never goes over the network: someone else on the Wi-Fi sees neither what was asked
// nor answered, and cannot answer in the person's place. A request carries its time and a
// nonce used once, so a recorded one cannot be sent again.

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
const BODY_MAX = 1024 * 1024
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
// is one), then the Bonjour name, the private IPv4 addresses and Tailscale's. `lan` false: the
// page listens on this computer only, and Tailscale HTTPS is the one way in.
export function mobileAddresses(port: number, where: { interfaces?: ReturnType<typeof networkInterfaces>; name?: string | null; https?: string | null; lan?: boolean } = {}): MobileAddress[] {
  const found: MobileAddress[] = []
  if (where.https) found.push({ address: where.https, kind: 'https', url: `https://${where.https}` })
  if (where.lan === false) return found
  if (where.name) found.push({ address: where.name, kind: 'name', url: `http://${where.name}:${port}` })
  const ips: MobileAddress[] = []
  for (const list of Object.values(where.interfaces ?? networkInterfaces())) {
    for (const one of list ?? []) {
      if (one.family !== 'IPv4' || one.internal || !privateAddress(one.address) || one.address.startsWith('169.254.')) continue
      ips.push({ address: one.address, kind: one.address.startsWith('100.') ? 'tailscale' : 'lan', url: `http://${one.address}:${port}` })
    }
  }
  return [...found, ...ips.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lan' ? -1 : 1))]
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

const reqAad = (device: number) => utf8(`sb1:req:${device}`)
const resAad = (device: number, nonce: string) => utf8(`sb1:res:${device}:${nonce}`)

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
  const run = options.run ?? runFile
  const tailscaleAt = options.tailscale === undefined ? tailscaleBin() : options.tailscale

  const keyOf = (id: number): Uint8Array | null => {
    const row = db.prepare('select key from mobile_devices where id = ?').get(id) as { key: string } | undefined
    return row ? fromB64(row.key) : null
  }
  const devices = (): Device[] => db.prepare('select id, name, created_at, last_seen from mobile_devices order by id').all() as Device[]

  const fresh = (device: number, nonce: string, at: number): boolean => {
    const list = seen.get(device) ?? new Map<string, number>()
    for (const [n, t] of list) if (now() - t > SKEW_MS * 2) list.delete(n)
    seen.set(device, list)
    if (Math.abs(now() - at) > SKEW_MS || list.has(nonce)) return false
    list.set(nonce, now())
    return true
  }

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    let text = ''
    for await (const chunk of req) {
      text += String(chunk)
      if (text.length > BODY_MAX) throw new Error('too large')
    }
    return text
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

  async function api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let outer: { d?: unknown; n?: unknown; c?: unknown }
    try {
      outer = JSON.parse(await readBody(req)) as typeof outer
    } catch {
      return reply(res, 400, { error: 'bad request' })
    }
    const device = Number(outer.d)
    const key = Number.isInteger(device) ? keyOf(device) : null
    if (!key || typeof outer.n !== 'string' || typeof outer.c !== 'string') return reply(res, 401, { error: 'unknown device' })
    let inner: { t?: unknown; method?: unknown; path?: unknown; body?: unknown }
    try {
      const plain = open(key, fromB64(outer.n), fromB64(outer.c), reqAad(device))
      if (!plain) return reply(res, 401, { error: 'unknown device' })
      inner = JSON.parse(fromUtf8(plain)) as typeof inner
    } catch {
      return reply(res, 401, { error: 'unknown device' })
    }
    if (!fresh(device, outer.n, Number(inner.t))) return reply(res, 409, { error: 'clock', now: now() })
    db.prepare('update mobile_devices set last_seen = ? where id = ?').run(now(), device)
    const method = String(inner.method)
    const path = String(inner.path)
    const result =
      path === '/push-key' || path === '/push'
        ? pushRoute(device, method, path, inner.body)
        : mobileRouteAllowed(method, path)
          ? await options.inner(method, path, inner.body ?? {})
          : { status: 403, json: { error: 'not allowed' } }
    const nonce = randomBytes(12)
    const sealed = seal(key, nonce, utf8(JSON.stringify(result)), resAad(device, outer.n))
    return reply(res, 200, { n: toB64(nonce), c: toB64(sealed) })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!privateAddress(req.socket.remoteAddress ?? '')) return reply(res, 403, { error: 'forbidden' })
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
    // Only that something changed, never what: the page then asks for the view.
    if (method === 'GET' && url.pathname === '/events') {
      const device = Number(url.searchParams.get('d'))
      if (!Number.isInteger(device) || !keyOf(device)) return reply(res, 401, { error: 'unknown device' })
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
      res.write(': connected\n\n')
      const stream = { res, device }
      streams.add(stream)
      const beat = setInterval(() => ping(res, ': beat\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(beat)
        streams.delete(stream)
      })
      return
    }
    if (method === 'POST' && url.pathname === '/api') return api(req, res)
    return reply(res, 404, { error: 'not found' })
  }

  const stop = (): Promise<void> =>
    new Promise(resolve => {
      for (const s of [...streams]) endStream(s)
      if (!server) return resolve()
      const closing = server
      server = null
      port = 0
      closing.closeAllConnections()
      closing.close(() => resolve())
    })

  const start = async (wanted: number, overLan = true): Promise<void> => {
    await stop()
    error = ''
    lan = overLan
    const next = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 400, { error: 'bad request' })
        else res.end()
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
  }

  return {
    start,
    stop,
    status: async (): Promise<MobileStatus> => {
      const tailscale = await tailscaleState(port, run, tailscaleAt)
      const addresses = server ? mobileAddresses(port, { name: bonjourName(), https: tailscale.served ? tailscale.domain : null, lan }) : []
      return { listening: server !== null, port, error, lan, addresses, devices: devices(), tailscale }
    },
    tailscale: (on: boolean) => setTailscaleServe(on, port, run, tailscaleAt),
    // A new phone: its id and key go into the QR code the app shows once.
    pair: (name: string): { id: number; key: string } => {
      const key = toB64(randomBytes(32))
      const id = Number(db.prepare('insert into mobile_devices (name, key, created_at) values (?, ?, ?)').run(name.slice(0, 60) || 'phone', key, now()).lastInsertRowid)
      return { id, key }
    },
    revoke: (id: number): boolean => {
      const removed = db.prepare('delete from mobile_devices where id = ?').run(id).changes > 0
      seen.delete(id)
      for (const s of [...streams]) if (s.device === id) endStream(s)
      return removed
    },
    changed: () => {
      for (const s of streams) ping(s.res, 'event: changed\ndata: {}\n\n')
    },
    // A notification to every phone that turned them on; one its push service forgot is dropped.
    notify: async (message: PushMessage): Promise<number> => {
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
