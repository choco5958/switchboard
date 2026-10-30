// The terminals themselves: node-pty processes, what they last printed and which program is
// in front of each. The terminal host (termHost.ts) runs them outside the app so they outlive
// it; where no host runs (Windows, see termClient.ts hostSupported) the app runs them in its
// own process through the same code. node-pty and the screen emulator come in as arguments,
// since the host loads them from the app's own files at run time.

import type { Snapshot, SpawnRequest, TermState } from './termProtocol.ts'

// The part of a node-pty IPty used here.
export type Pty = {
  readonly pid: number
  readonly process: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown
}

export type SpawnPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty

// A headless xterm that keeps the screen for a later attach (termHost.ts). `done` runs once
// everything written before it is parsed.
export type Emulator = { write(data: string, done?: () => void): void; resize(cols: number, rows: number): void; serialize(): string; dispose(): void }

export type CoreEvents = {
  data(id: string, data: string): void
  exit(id: string, code: number | null): void
  fg(id: string, fg: string): void
}

export type CoreOptions = {
  emulator?: (cols: number, rows: number) => Emulator
  now?: () => number
  // How often the program in front is read while nothing is printed.
  fgMs?: number
}

type Term = TermState & { pty: Pty; emulator: Emulator | null; fgTimer: ReturnType<typeof setTimeout> | null }

// Read this soon after output, at most once per this time: a CLI that quits prints its last
// lines and the shell's prompt, and the typing must see the shell before it types again.
const FG_AFTER_DATA_MS = 100

export function createCore(spawnPty: SpawnPty, events: CoreEvents, options: CoreOptions = {}) {
  const now = options.now ?? Date.now
  const terms = new Map<string, Term>()

  const state = (term: Term): TermState => ({
    id: term.id,
    meta: term.meta,
    alive: term.alive,
    exitCode: term.exitCode,
    fg: term.fg,
    lastOutput: term.lastOutput,
    started: term.started,
    cols: term.cols,
    rows: term.rows,
  })

  const readFg = (term: Term) => {
    term.fgTimer = null
    if (!term.alive) return
    let fg = ''
    try {
      fg = term.pty.process
    } catch {
      // Gone between the check and the read.
    }
    if (fg === term.fg) return
    term.fg = fg
    events.fg(term.id, fg)
  }

  const poll = setInterval(() => {
    for (const term of terms.values()) readFg(term)
  }, options.fgMs ?? 1000)
  poll.unref?.()

  const forget = (term: Term) => {
    if (term.fgTimer) clearTimeout(term.fgTimer)
    term.emulator?.dispose()
    terms.delete(term.id)
  }

  return {
    // Starts a terminal; throws when node-pty cannot (no such shell, no such folder).
    spawn(request: SpawnRequest): number {
      if (terms.has(request.id)) throw new Error(`terminal ${request.id} exists`)
      const cols = Math.max(2, request.cols)
      const rows = Math.max(1, request.rows)
      const pty = spawnPty(request.file, request.args, { name: 'xterm-256color', cols, rows, cwd: request.cwd, env: request.env })
      const term: Term = {
        id: request.id,
        meta: request.meta,
        alive: true,
        exitCode: null,
        fg: '',
        lastOutput: now(),
        started: now(),
        cols,
        rows,
        pty,
        emulator: options.emulator?.(cols, rows) ?? null,
        fgTimer: null,
      }
      terms.set(term.id, term)
      pty.onData(data => {
        term.lastOutput = now()
        term.emulator?.write(data)
        events.data(term.id, data)
        term.fgTimer ??= setTimeout(() => readFg(term), FG_AFTER_DATA_MS)
      })
      pty.onExit(({ exitCode }) => {
        term.alive = false
        term.exitCode = exitCode
        term.fg = ''
        // A terminal closed on purpose is forgotten already: nobody waits for its end.
        if (terms.get(term.id) === term) events.exit(term.id, exitCode)
      })
      return pty.pid
    },

    write(id: string, data: string): void {
      const term = terms.get(id)
      if (term?.alive) term.pty.write(data)
    },

    resize(id: string, cols: number, rows: number): void {
      const term = terms.get(id)
      if (!term?.alive || !(cols > 0) || !(rows > 0)) return
      term.cols = cols
      term.rows = rows
      term.pty.resize(cols, rows)
      term.emulator?.resize(cols, rows)
    },

    // Ends the terminal's program (the shell and what runs in it) and forgets the terminal.
    kill(id: string): boolean {
      const term = terms.get(id)
      if (!term) return false
      forget(term)
      if (term.alive) {
        try {
          term.pty.kill()
        } catch {
          // Already gone.
        }
      }
      return true
    },

    killAll(): void {
      for (const id of [...terms.keys()]) this.kill(id)
    },

    list(): TermState[] {
      return [...terms.values()].map(state)
    },

    // The terminal as it looks once all output so far is parsed. What it prints after this
    // call is not in the snapshot: the host sends that as live data (termHost.ts attach).
    snapshot(id: string): Promise<Snapshot | null> {
      const term = terms.get(id)
      if (!term) return Promise.resolve(null)
      const emulator = term.emulator
      if (!emulator) return Promise.resolve({ ...state(term), screen: '' })
      return new Promise(resolve => {
        // A terminal closed meanwhile disposes its emulator, which then never calls back.
        const late = setTimeout(() => resolve(null), 5000)
        emulator.write('', () => {
          clearTimeout(late)
          resolve(terms.get(id) === term ? { ...state(term), screen: emulator.serialize() } : null)
        })
      })
    },

    has(id: string): boolean {
      return terms.has(id)
    },

    aliveCount(): number {
      return [...terms.values()].filter(term => term.alive).length
    },

    dispose(): void {
      clearInterval(poll)
      this.killAll()
    },
  }
}

export type Core = ReturnType<typeof createCore>
