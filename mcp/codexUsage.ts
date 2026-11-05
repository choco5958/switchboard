// Codex's plan usage for the usage bar and the limit hold (src/shared/limit.ts), as the mod
// reports Claude Code's. `codex app-server` answers account/rateLimits/read with the account's
// windows (learn.chatgpt.com/docs/app-server); one runs beside the session's MCP server, reading
// the person's own Codex login, and ends with it.
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { createInterface } from 'node:readline'

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

// The windows the app knows by name (TopBar.tsx): five hours and a week.
const KINDS: Record<number, string> = { 300: 'five_hour', 10080: 'seven_day' }

// The app-server's rate limits (the reply's result, or an account/rateLimits/updated params) as the
// bridge keeps them. Windows of other lengths are left out.
export function rateLimitsOf(value: unknown): RateLimit[] {
  const limits = object(object(value).rateLimits)
  const out: RateLimit[] = []
  for (const window of [limits.primary, limits.secondary]) {
    const w = object(window)
    const kind = KINDS[Number(w.windowDurationMins)]
    const percent = Number(w.usedPercent)
    if (!kind || !Number.isFinite(percent) || out.some(l => l.kind === kind)) continue
    const resets = Number(w.resetsAt)
    out.push({ kind, percentUsed: percent, ...(Number.isFinite(resets) && resets > 0 ? { resetsAt: new Date(resets * 1000).toISOString() } : {}) })
  }
  return out
}

const NATIVE = ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', '7f454c46', '4d5a9000']

// How to start the codex the app found: a native program as it is, the npm package's script with
// the Node this server runs on (the CLI may hand its MCP servers no PATH to find one).
export function codexArgv(path: string, node: string = process.execPath): string[] {
  let head = ''
  try {
    const fd = openSync(path, 'r')
    const bytes = Buffer.alloc(4)
    readSync(fd, bytes, 0, 4, 0)
    closeSync(fd)
    head = bytes.toString('hex')
  } catch {
    return []
  }
  return NATIVE.includes(head) || head.startsWith('4d5a') ? [path] : [node, path]
}

export const USAGE_EVERY_MS = 120_000

// Reads now and every `everyMs`, and on each update the app-server sends. Returns the stop.
export function watchCodexUsage(argv: string[], env: NodeJS.ProcessEnv, report: (limits: RateLimit[]) => void, everyMs = USAGE_EVERY_MS): () => void {
  if (argv.length === 0) return () => undefined
  let child: ChildProcess
  try {
    child = spawn(argv[0]!, [...argv.slice(1), 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch {
    return () => undefined
  }
  let next = 1
  let timer: ReturnType<typeof setInterval> | null = null
  const pending = new Map<number, (m: Json) => void>()
  const write = (m: Json) => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  }
  const call = (method: string, params: Json) =>
    new Promise<Json>(resolve => {
      const id = next++
      pending.set(id, resolve)
      write({ id, method, params })
    })
  const send = (value: unknown) => {
    const limits = rateLimitsOf(value)
    if (limits.length > 0) report(limits)
  }
  const read = () => void call('account/rateLimits/read', {}).then(m => send(m.result))
  child.on('error', () => undefined)
  child.on('exit', () => {
    if (timer) clearInterval(timer)
  })
  createInterface({ input: child.stdout! }).on('line', line => {
    let m: Json
    try {
      m = object(JSON.parse(line))
    } catch {
      return
    }
    if (typeof m.id === 'number' && pending.has(m.id) && m.method === undefined) {
      pending.get(m.id)!(m)
      pending.delete(m.id)
    } else if (m.method === 'account/rateLimits/updated') send(m.params)
  })
  void call('initialize', { clientInfo: { name: 'switchboard', version: '1' } }).then(() => {
    write({ method: 'initialized' })
    read()
    timer = setInterval(read, everyMs)
    timer.unref()
  })
  return () => {
    if (timer) clearInterval(timer)
    child.kill()
  }
}
