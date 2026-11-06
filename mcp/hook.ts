// A CLI's permission hook: `node mcp/hook.ts <agent>`, started by the CLI with the ask as JSON on
// stdin (mcp/permission.ts). It asks the MCP server of the same run and prints the answer in the
// CLI's form. Anything amiss (no terminal key, no server, bad input) prints nothing, and the CLI
// asks in its terminal as it would without the hook. Run with Node 24.
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { ADAPTERS, HOOK_WAIT_MS, PASS, hookSocket, type HookAnswer, type HookAsk, type HookEvent, type HookEventReply } from './permission.ts'

const LIMIT = 4 * 1024 * 1024

function readAll(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    input.setEncoding('utf8')
    input.on('data', chunk => {
      data += chunk
      if (data.length > LIMIT) resolve('')
    })
    input.on('end', () => resolve(data))
    input.on('error', () => resolve(''))
  })
}

// One request and one answer line over the server's socket.
// `signal`: the ask was answered elsewhere; closing the socket withdraws it (mcp/server.ts).
export function askServer(path: string, terminal: string, ask: HookAsk, waitMs = HOOK_WAIT_MS, signal?: AbortSignal): Promise<HookAnswer> {
  return new Promise(resolve => {
    let reply = ''
    let done = false
    const finish = (answer: HookAnswer) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const socket = connect(path)
    const timer = setTimeout(() => finish(PASS), waitMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ terminal, ask })}\n`))
    socket.on('data', chunk => {
      reply += chunk
      const end = reply.indexOf('\n')
      if (end < 0) return
      try {
        const parsed = JSON.parse(reply.slice(0, end)) as Partial<HookAnswer>
        const answer = parsed.answer === 'allow' || parsed.answer === 'deny' ? parsed.answer : 'ask'
        finish({ answer, message: typeof parsed.message === 'string' ? parsed.message : '' })
      } catch {
        finish(PASS)
      }
    })
    socket.on('error', () => finish(PASS))
    socket.on('close', () => finish(PASS))
    if (signal?.aborted) finish(PASS)
    signal?.addEventListener('abort', () => finish(PASS), { once: true })
  })
}

// How long an event waits for the server: a turn's start waits for the context it adds, the rest
// for nothing much. The CLI goes on without it after this.
export const EVENT_WAIT_MS = 8000

// One event and the server's reply ({} when there is none, or no server).
export function tellServer(path: string, terminal: string, event: HookEvent, waitMs = EVENT_WAIT_MS): Promise<HookEventReply> {
  return new Promise(resolve => {
    let reply = ''
    let done = false
    const finish = (value: HookEventReply) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const socket = connect(path)
    const timer = setTimeout(() => finish({}), waitMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ terminal, event })}\n`))
    socket.on('data', chunk => {
      reply += chunk
      const end = reply.indexOf('\n')
      if (end < 0) return
      try {
        const parsed = JSON.parse(reply.slice(0, end)) as HookEventReply
        finish(typeof parsed.context === 'string' && parsed.context ? { context: parsed.context } : {})
      } catch {
        finish({})
      }
    })
    socket.on('error', () => finish({}))
    socket.on('close', () => finish({}))
  })
}

// `eventName`: the hook's event as its command line names it, for a CLI that leaves it out of the
// input (Copilot, but for permissionRequest).
export async function runHook(agent: string, stdin: string, env: Record<string, string | undefined>, eventName = ''): Promise<string> {
  const adapter = ADAPTERS[agent]
  const terminal = env.SWITCHBOARD_TERMINAL ?? ''
  if (!adapter || !terminal) return ''
  let input: unknown
  try {
    input = JSON.parse(stdin)
  } catch {
    return ''
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ''
  const named = input as Record<string, unknown>
  if (eventName && named.hookName === undefined) named.hookName = eventName
  const socket = hookSocket(env.HOME || homedir(), terminal)
  const ask = adapter.ask(input as Record<string, unknown>)
  const event = adapter.event?.(input as Record<string, unknown>)
  if (ask) {
    // A CLI whose ask comes from the hook a tool starts with (Crush): the tool starts once allowed.
    const answer = await askServer(socket, terminal, ask)
    if (event && answer.answer !== 'deny') await tellServer(socket, terminal, event)
    return adapter.reply(answer)
  }
  if (!event) return ''
  // Told first: `eventReply?.(…)` would skip its arguments, the telling with them, for a CLI without one.
  const reply = await tellServer(socket, terminal, event)
  return adapter.eventReply?.(event, reply) ?? ''
}

if (import.meta.main) {
  const out = await runHook(String(process.argv[2] ?? ''), await readAll(process.stdin), process.env, String(process.argv[3] ?? '')).catch(() => '')
  if (out) process.stdout.write(`${out}\n`)
  process.exit(0)
}
