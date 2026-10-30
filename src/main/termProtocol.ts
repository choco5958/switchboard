// What the app and its terminal host (termHost.ts) say to each other: one JSON message per
// line over a Unix socket in ~/.claude-ide/termhosts, named after the host's build. Each build
// of the app has a host of its own, so after an update the old host keeps the terminals it has
// while the new one takes the new ones. The host runs as plain Node (the app's executable in
// Node mode, or node in the tests): this file imports nothing but Node's own modules.

import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'

// A snapshot with a long scrollback is the largest line; anything far past it is not ours.
export const MAX_LINE = 32 * 1024 * 1024

// What the app needs to show a terminal again after a restart: the dock tab and the typing
// target (terminals.ts). The host keeps it as given and hands it back.
export type TermMeta = {
  project: string
  cwd: string
  title: string
  claude: boolean
  agent?: string
  shell: string
  bins: string[]
}

// `fg`: the program in front of the terminal (node-pty's `process`), for the answer typing.
// `lastOutput`: when it last printed. `started`: the order the dock shows them in.
export type TermState = {
  id: string
  meta: TermMeta
  alive: boolean
  exitCode: number | null
  fg: string
  lastOutput: number
  started: number
  cols: number
  rows: number
}

// `screen`: the terminal as it looks now, scrollback included, as text an xterm draws again.
export type Snapshot = TermState & { screen: string }

export type SpawnRequest = {
  id: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  meta: TermMeta
}

// From the app. `rid` pairs a request with its reply; write and resize have none.
export type Request =
  | { t: 'hello'; key: string; build: string }
  | ({ t: 'spawn'; rid: number } & SpawnRequest)
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; rid: number; id: string }
  | { t: 'killAll'; rid: number }
  | { t: 'list'; rid: number }
  | { t: 'attach'; rid: number; id: string }

export type Reply = { t: 'reply'; rid: number; ok: boolean; error?: string; pid?: number; terms?: TermState[]; snapshot?: Snapshot }

// From the host. data, exit and fg go to every app attached to that terminal.
export type Message =
  | { t: 'hello'; build: string; pid: number }
  | Reply
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number | null }
  | { t: 'fg'; id: string; fg: string }

export function encode(message: Request | Message): string {
  return `${JSON.stringify(message)}\n`
}

// Splits a stream into messages. A line that does not parse is skipped; one longer than
// MAX_LINE ends the connection (`tooLong`), as no sender of ours writes it.
export function lineReader(onMessage: (message: Record<string, unknown>) => void, tooLong: () => void): (chunk: string) => void {
  let buffer = ''
  return chunk => {
    // Only the new part can hold the line's end: a snapshot arrives in many chunks.
    const from = buffer.length
    buffer += chunk
    let end = buffer.indexOf('\n', from)
    while (end !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      end = buffer.indexOf('\n')
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message && typeof message === 'object' && !Array.isArray(message)) onMessage(message as Record<string, unknown>)
    }
    if (buffer.length > MAX_LINE) {
      buffer = ''
      tooLong()
    }
  }
}

// The app's key, compared without telling by how long it took how much of it was right.
export function keyMatches(given: unknown, key: string): boolean {
  if (typeof given !== 'string' || !key) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(key).digest()
  return timingSafeEqual(a, b)
}

// A build becomes a file name: the version and the content hash (runtime.ts buildId).
export function validBuild(build: unknown): build is string {
  return typeof build === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(build)
}

export function hostDir(home: string): string {
  return join(home, '.claude-ide', 'termhosts')
}

export function hostSocket(dir: string, build: string): string {
  return join(dir, `${build}.sock`)
}

// The build a socket in the folder belongs to, or null for any other file.
export function buildOfSocket(name: string): string | null {
  const match = /^(.+)\.sock$/.exec(name)
  return match && validBuild(match[1]) ? match[1] : null
}
