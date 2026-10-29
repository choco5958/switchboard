// How a client reaches the bridge. macOS and Linux: the Unix socket ~/.claude-ide/bridge.sock
// (CLAUDE_IDE_SOCKET when set). Windows: its Node cannot listen on a socket path, and the
// mod's fetch and curl cannot open a named pipe, so the bridge listens on 127.0.0.1 with a
// port and a token it picks at each start and writes to ~/.claude-ide/bridge.json, in the
// person's own profile. CLAUDE_IDE_TCP=1 takes that road anywhere (tests, trying it on a
// Mac). mod/hooks/link.ts is the mod's twin of this file.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The header the app proves itself with on the person-only routes (bridge/server.ts appOnly).
export const APP_HEADER = 'x-switchboard-app'

export type Endpoint = { kind: 'socket'; path: string } | { kind: 'tcp'; port: number; token: string }

type Env = Record<string, string | undefined>

export function usesTcp(env: Env = process.env, platform: string = process.platform): boolean {
  if (env.CLAUDE_IDE_SOCKET) return false
  return env.CLAUDE_IDE_TCP === '1' || platform === 'win32'
}

export function ideDir(home: string = homedir()): string {
  return join(home, '.claude-ide')
}

export function endpointFile(home: string = homedir()): string {
  return join(ideDir(home), 'bridge.json')
}

// curl reads the token from here (-K) instead of a command line others could list.
export function curlConfigFile(home: string = homedir()): string {
  return join(ideDir(home), 'bridge.curl')
}

// Read at each call: the port changes whenever the bridge starts again.
export function resolveEndpoint(env: Env = process.env, home: string = homedir(), platform: string = process.platform): Endpoint {
  if (!usesTcp(env, platform)) return { kind: 'socket', path: env.CLAUDE_IDE_SOCKET ?? join(ideDir(home), 'bridge.sock') }
  try {
    const saved = JSON.parse(readFileSync(endpointFile(home), 'utf8')) as { port?: unknown; token?: unknown }
    if (typeof saved.port === 'number' && typeof saved.token === 'string') return { kind: 'tcp', port: saved.port, token: saved.token }
  } catch {
    // No bridge has started yet: the request below fails as a closed socket would.
  }
  return { kind: 'tcp', port: 0, token: '' }
}

// What node:http's request() takes to reach the bridge; `headers` go with every request.
export function requestTarget(endpoint: Endpoint): { socketPath?: string; host?: string; port?: number; headers: Record<string, string> } {
  if (endpoint.kind === 'socket') return { socketPath: endpoint.path, headers: {} }
  return { host: '127.0.0.1', port: endpoint.port || 1, headers: { authorization: `Bearer ${endpoint.token}` } }
}

export function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.kind === 'socket' ? endpoint.path : `127.0.0.1:${endpoint.port}`
}

export type StartCommand = { argv: string[]; env: Record<string, string> }

// How to start the bridge (bridge/start.ts) without a shell: start-bridge.json, which the
// installed app and `pnpm run setup` write; start-bridge.sh from before that file existed.
export function startCommand(home: string = homedir()): StartCommand {
  try {
    const saved = JSON.parse(readFileSync(join(ideDir(home), 'start-bridge.json'), 'utf8')) as { argv?: unknown; env?: unknown }
    if (Array.isArray(saved.argv) && saved.argv.length > 0 && saved.argv.every(a => typeof a === 'string')) {
      const env = saved.env !== null && typeof saved.env === 'object' ? (saved.env as Record<string, string>) : {}
      return { argv: saved.argv as string[], env }
    }
  } catch {
    // Not written yet.
  }
  return { argv: ['sh', join(ideDir(home), 'start-bridge.sh')], env: {} }
}

export type RequestTarget = ReturnType<typeof requestTarget>
