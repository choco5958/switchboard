// A CLI's permission hook: `node mcp/hook.ts <agent>`, started by the CLI with the ask as JSON on
// stdin (mcp/permission.ts). It asks the MCP server of the same run and prints the answer in the
// CLI's form. Anything amiss (no terminal key, no server, bad input) prints nothing, and the CLI
// asks in its terminal as it would without the hook. Run with Node 24.
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { ADAPTERS, HOOK_WAIT_MS, PASS, hookSocket, type HookAnswer, type HookAsk } from './permission.ts'

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
export function askServer(path: string, terminal: string, ask: HookAsk, waitMs = HOOK_WAIT_MS): Promise<HookAnswer> {
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
  })
}

export async function runHook(agent: string, stdin: string, env: Record<string, string | undefined>): Promise<string> {
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
  const ask = adapter.ask(input as Record<string, unknown>)
  if (!ask) return ''
  return adapter.reply(await askServer(hookSocket(env.HOME || homedir(), terminal), terminal, ask))
}

if (import.meta.main) {
  const out = await runHook(String(process.argv[2] ?? ''), await readAll(process.stdin), process.env).catch(() => '')
  if (out) process.stdout.write(`${out}\n`)
  process.exit(0)
}
