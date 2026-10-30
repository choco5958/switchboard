// How the mod reaches the bridge, the twin of bridge/endpoint.ts: the Unix socket
// ~/.claude-ide/bridge.sock (CLAUDE_IDE_SOCKET when set), or, on Windows (CLAUDE_IDE_TCP=1
// anywhere), 127.0.0.1 with the port and token the bridge wrote to ~/.claude-ide/bridge.json
// at its start. The stream of deliveries goes through curl, which reads the token from
// bridge.curl rather than its command line.

import type { EngineInterface as Engine } from 'claude-code'

type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Link = { kind: 'socket'; path: string } | { kind: 'tcp'; port: number; token: string }

let home = ''
let tcp: boolean | undefined

export async function homeOf($: Engine): Promise<string> {
  if (home) return home
  const fromEnv = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  home = (fromEnv || (await $.process.run(['printenv', 'HOME'])).stdout.trim()).replace(/\\/g, '/')
  return home
}

async function overTcp($: Engine): Promise<boolean> {
  if (tcp === undefined) {
    const socket = await $.env.get('CLAUDE_IDE_SOCKET').catch(() => undefined)
    const forced = (await $.env.get('CLAUDE_IDE_TCP').catch(() => undefined)) === '1'
    const windows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    tcp = !socket && (forced || windows)
  }
  return tcp
}

// Read at each call on TCP: the port changes whenever the bridge starts again.
async function linkOf($: Engine): Promise<Link> {
  const dir = `${await homeOf($)}/.claude-ide`
  if (!(await overTcp($))) return { kind: 'socket', path: (await $.env.get('CLAUDE_IDE_SOCKET').catch(() => undefined)) || `${dir}/bridge.sock` }
  try {
    const saved = JSON.parse(String(await $.fs.read(`${dir}/bridge.json`))) as { port?: unknown; token?: unknown }
    if (typeof saved.port === 'number' && typeof saved.token === 'string') return { kind: 'tcp', port: saved.port, token: saved.token }
  } catch {
    // No bridge has started yet.
  }
  return { kind: 'tcp', port: 1, token: '' }
}

export async function socketOf($: Engine): Promise<string> {
  const link = await linkOf($)
  return link.kind === 'socket' ? link.path : `127.0.0.1:${link.port}`
}

export async function bridgeFetch($: Engine, path: string, init: Init = {}) {
  const link = await linkOf($)
  if (link.kind === 'socket') return $.http.fetch(`http://bridge${path}`, { ...init, socketPath: link.path })
  return $.http.fetch(`http://127.0.0.1:${link.port}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${link.token}` } })
}

// The header this session proves itself with on its own routes (bridge/endpoint.ts SESSION_HEADER).
export const SESSION_HEADER = 'x-switchboard-session'

// The curl command that holds the delivery stream open. `headerOnStdin`: curl reads a header
// (the session's token) from its standard input, never from its command line, which any
// program of the same user can list.
export async function streamArgv($: Engine, path: string, headerOnStdin = false): Promise<string[]> {
  const link = await linkOf($)
  const header = headerOnStdin ? ['-H', '@-'] : []
  if (link.kind === 'socket') return ['curl', '-sN', ...header, '--unix-socket', link.path, `http://bridge${path}`]
  return ['curl', '-sN', ...header, '-K', `${await homeOf($)}/.claude-ide/bridge.curl`, `http://127.0.0.1:${link.port}${path}`]
}

// How to start the bridge: start-bridge.json (the installed app and `pnpm run setup` write
// it), else start-bridge.sh from before that file existed.
export async function startArgv($: Engine): Promise<{ argv: string[]; env: Record<string, string> }> {
  const dir = `${await homeOf($)}/.claude-ide`
  try {
    const saved = JSON.parse(String(await $.fs.read(`${dir}/start-bridge.json`))) as { argv?: unknown; env?: unknown }
    if (Array.isArray(saved.argv) && saved.argv.length > 0 && saved.argv.every(a => typeof a === 'string')) {
      const env = saved.env !== null && typeof saved.env === 'object' ? Object.entries(saved.env) : []
      return { argv: saved.argv as string[], env: Object.fromEntries(env.filter((pair): pair is [string, string] => typeof pair[1] === 'string')) }
    }
  } catch {
    // Not written yet.
  }
  return { argv: ['sh', `${dir}/start-bridge.sh`], env: {} }
}
