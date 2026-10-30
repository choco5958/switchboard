// Where the app's terminals run (termCore.ts): in the terminal host (termHost.ts), which
// outlives the app, or in the app's own process where no host can run. Either way the
// terminals module (terminals.ts) sees one backend with the same calls and events.
// Nothing here imports Electron, so the tests run all of it.

import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCore, type CoreEvents, type SpawnPty } from './termCore.ts'
import { buildOfSocket, encode, hostSocket, lineReader, type Message, type Reply, type Request, type Snapshot, type SpawnRequest, type TermState } from './termProtocol.ts'

export type TermBackend = {
  // Whether its terminals keep running after the app quits.
  keeps: boolean
  spawn(request: SpawnRequest): Promise<{ pid: number } | { error: string }>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  // Ends the terminal's program and forgets the terminal.
  kill(id: string): Promise<void>
  killAll(): Promise<void>
}

// The host's terminals hold a terminal's events back for no one: a host that goes away (a
// crash, a kill) reports each of its terminals ended with no exit code.
export type HostEvents = CoreEvents & { lost(id: string): void }

// The spawn error when no host answers: terminals.ts words it for the screen.
export const HOST_DOWN = 'terminal host unavailable'

// Where a host keeps terminals past the app. Not on Windows: a running host would hold the
// app's executable, and the installer cannot replace a file in use. Not without a key that
// lasts (appKey.ts): the next start could not prove itself to the host and would never see
// those terminals again. Not in captures, which leave nothing running behind them.
// SWITCHBOARD_NO_TERMHOST=1 keeps terminals in the app, for anyone who wants the old way.
export function hostSupported(platform: string, lastingKey: boolean, env: Record<string, string | undefined>): boolean {
  if (platform !== 'darwin' && platform !== 'linux') return false
  if (!lastingKey || env.CLAUDE_IDE_CAPTURE || env.SWITCHBOARD_NO_TERMHOST === '1') return false
  return true
}

// Terminals in the app's own process: they end with it, as before the host existed.
export function localBackend(spawnPty: SpawnPty, events: CoreEvents): TermBackend {
  const core = createCore(spawnPty, events)
  return {
    keeps: false,
    spawn: async request => {
      try {
        return { pid: core.spawn(request) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    write: (id, data) => core.write(id, data),
    resize: (id, cols, rows) => core.resize(id, cols, rows),
    kill: async id => void core.kill(id),
    killAll: async () => core.killAll(),
  }
}

type WithoutRid<T> = T extends { rid: number } ? Omit<T, 'rid'> : never

// One authenticated connection to a host.
export class HostConnection {
  closed = false
  onMessage: (message: Message) => void = () => undefined
  onClose: () => void = () => undefined
  private rid = 0
  private readonly waiting = new Map<number, (reply: Reply) => void>()

  private readonly socket: Socket
  readonly build: string
  readonly pid: number

  constructor(socket: Socket, build: string, pid: number) {
    this.socket = socket
    this.build = build
    this.pid = pid
  }

  // `done` runs in the same turn the reply is read, before any message after it.
  call(message: WithoutRid<Request>, done: (reply: Reply) => void): void {
    if (this.closed) return done({ t: 'reply', rid: 0, ok: false, error: 'closed' })
    const rid = ++this.rid
    this.waiting.set(rid, done)
    this.socket.write(encode({ ...message, rid } as Request))
  }

  request(message: WithoutRid<Request>): Promise<Reply> {
    return new Promise(resolve => this.call(message, resolve))
  }

  send(message: Request): void {
    if (!this.closed) this.socket.write(encode(message))
  }

  close(): void {
    this.socket.destroy()
  }

  // Called by openHost for each message after the greeting.
  receive(message: Message): void {
    if (message.t === 'reply') {
      const done = this.waiting.get(message.rid)
      this.waiting.delete(message.rid)
      done?.(message)
    } else this.onMessage(message)
  }

  ended(): void {
    if (this.closed) return
    this.closed = true
    for (const done of this.waiting.values()) done({ t: 'reply', rid: 0, ok: false, error: 'closed' })
    this.waiting.clear()
    this.onClose()
  }
}

// 'dead': nothing listens there (a host that crashed left its socket). 'refused': something
// listens but did not take the key (another install's host, or one that is not a host).
export function openHost(path: string, key: string, build: string, timeoutMs = 3000): Promise<HostConnection | 'dead' | 'refused'> {
  return new Promise(resolve => {
    const socket = connect(path)
    let conn: HostConnection | null = null
    let settled = false
    const settle = (result: HostConnection | 'dead' | 'refused') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result !== conn) socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => settle('refused'), timeoutMs)
    let connected = false
    socket.setEncoding('utf8')
    const read = lineReader(
      message => {
        if (conn) return conn.receive(message as Message)
        if (message.t !== 'hello' || typeof message.pid !== 'number') return settle('refused')
        conn = new HostConnection(socket, String(message.build), message.pid)
        settle(conn)
      },
      () => socket.destroy(),
    )
    socket.on('connect', () => {
      connected = true
      socket.write(encode({ t: 'hello', key, build }))
    })
    socket.on('data', (chunk: string) => read(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (conn) conn.ended()
      settle(connected ? 'refused' : 'dead')
    })
  })
}

// The builds whose host has a socket in the folder: running, or crashed and not yet cleared.
export function hostBuilds(dir: string): string[] {
  try {
    return readdirSync(dir).map(buildOfSocket).filter((build): build is string => build !== null)
  } catch {
    return []
  }
}

export type LaunchOptions = {
  // The app's executable, run as Node; on Linux the AppImage file when the app is one, so the
  // host gets a mount of its own that lasts as long as it does (as the bridge, index.ts).
  execPath: string
  // execPath is an AppImage. Its launcher adds --no-sandbox in front of the arguments where user
  // namespaces are off, which Node refuses as an option of its own; given after the script, it
  // is left alone.
  appImage?: boolean
  script: string // termHost.ts
  build: string
  dir: string // the sockets' folder (termProtocol.ts hostDir)
  key: string
  log: string
  // Where node-pty and the emulator are; left out, the host finds the app.asar beside itself.
  modules?: string
  idleMs?: number
  env?: Record<string, string | undefined>
}

// A log that grew past this starts again at the next launch.
const LOG_MAX = 5 * 1024 * 1024

export function launchHost(options: LaunchOptions): void {
  mkdirSync(dirname(options.log), { recursive: true, mode: 0o700 })
  let size = 0
  try {
    size = statSync(options.log).size
  } catch {
    // No log yet.
  }
  const log = openSync(options.log, size > LOG_MAX ? 'w' : 'a', 0o600)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(options.execPath, options.appImage ? [options.script, '--no-sandbox'] : [options.script], {
      detached: true,
      // Its own folder: the runtime copy it was started from may be pruned after an update.
      cwd: options.dir,
      stdio: ['pipe', log, log],
      env: {
        ...(options.env ?? process.env),
        ELECTRON_RUN_AS_NODE: '1',
        SWITCHBOARD_TERMHOST_BUILD: options.build,
        SWITCHBOARD_TERMHOST_DIR: options.dir,
        ...(options.modules ? { SWITCHBOARD_MODULES: options.modules } : {}),
        ...(options.idleMs ? { SWITCHBOARD_TERMHOST_IDLE_MS: String(options.idleMs) } : {}),
      },
    })
  } finally {
    closeSync(log)
  }
  child.on('error', error => console.error('could not start the terminal host:', error.message))
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(`${options.key}\n`)
  child.unref()
}

export type Hosts = TermBackend & {
  // Attaches to every host that runs, in the order their terminals started; `found` gets each
  // terminal in the same turn its snapshot arrives, so none of its output after it is missed.
  restore(found: (snapshot: Snapshot) => void): Promise<void>
  // Makes sure this build's host runs (started now if not); false when it could not start.
  ready(): Promise<boolean>
  close(): void
}

export function terminalHosts(options: LaunchOptions & { events: HostEvents; launch?: (options: LaunchOptions) => void }): Hosts {
  const conns = new Map<string, HostConnection>()
  // Which host serves each terminal.
  const owner = new Map<string, HostConnection>()
  // Terminals whose spawn is on its way: writes made meanwhile follow it.
  const starting = new Map<string, Promise<HostConnection | null>>()
  const launch = options.launch ?? launchHost
  const events = options.events

  const adopt = (conn: HostConnection) => {
    conns.set(conn.build, conn)
    conn.onMessage = message => {
      if (message.t === 'data') events.data(message.id, message.data)
      else if (message.t === 'exit') events.exit(message.id, message.code)
      else if (message.t === 'fg') events.fg(message.id, message.fg)
    }
    conn.onClose = () => {
      if (conns.get(conn.build) === conn) conns.delete(conn.build)
      for (const [id, one] of [...owner]) {
        if (one !== conn) continue
        owner.delete(id)
        events.lost(id)
      }
    }
  }

  let own: Promise<HostConnection | null> | null = null
  const ownHost = (): Promise<HostConnection | null> => {
    const existing = conns.get(options.build)
    if (existing && !existing.closed) return Promise.resolve(existing)
    own ??= (async () => {
      const path = hostSocket(options.dir, options.build)
      let conn = await openHost(path, options.key, options.build)
      if (conn === 'dead') {
        rmSync(path, { force: true })
        launch(options)
        for (let i = 0; i < 80 && typeof conn === 'string'; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          conn = await openHost(path, options.key, options.build)
          // A host that refuses the key will not change its mind.
          if (conn === 'refused') break
        }
      }
      if (typeof conn === 'string') {
        console.error(`the terminal host of build ${options.build} is ${conn === 'refused' ? 'refusing the app key' : 'not answering'}`)
        return null
      }
      adopt(conn)
      return conn
    })().finally(() => (own = null))
    return own
  }

  const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
    Promise.race([promise, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms).unref?.())])

  return {
    keeps: true,

    async restore(found) {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 })
      const listed: { conn: HostConnection; term: TermState }[] = []
      for (const name of readdirSync(options.dir)) {
        const build = buildOfSocket(name)
        if (!build) continue
        const path = hostSocket(options.dir, build)
        const conn = await openHost(path, options.key, options.build)
        if (conn === 'dead') {
          rmSync(path, { force: true })
          continue
        }
        if (conn === 'refused') {
          console.error(`the terminal host at ${path} refused the app key; leaving it`)
          continue
        }
        adopt(conn)
        const reply = await conn.request({ t: 'list' })
        for (const term of reply.terms ?? []) listed.push({ conn, term })
      }
      listed.sort((a, b) => a.term.started - b.term.started)
      for (const { conn, term } of listed) {
        await new Promise<void>(done =>
          conn.call({ t: 'attach', id: term.id }, reply => {
            if (reply.snapshot && !conn.closed) {
              owner.set(term.id, conn)
              found(reply.snapshot)
            }
            done()
          }),
        )
      }
    },

    ready: async () => (await ownHost()) !== null,

    async spawn(request) {
      // The spawn is sent in the turn the host is known, so writes queued on `ready` follow it.
      const ready = ownHost().then(conn => {
        if (conn) owner.set(request.id, conn)
        return conn
      })
      starting.set(request.id, ready)
      try {
        const conn = await ready
        if (!conn) return { error: HOST_DOWN }
        const reply = await conn.request({ t: 'spawn', ...request })
        if (reply.ok) return { pid: reply.pid ?? 0 }
        owner.delete(request.id)
        return { error: reply.error ?? 'spawn failed' }
      } finally {
        starting.delete(request.id)
      }
    },

    write(id, data) {
      const conn = owner.get(id)
      if (conn) conn.send({ t: 'write', id, data })
      else void starting.get(id)?.then(one => one?.send({ t: 'write', id, data }))
    },

    resize(id, cols, rows) {
      owner.get(id)?.send({ t: 'resize', id, cols, rows })
    },

    async kill(id) {
      const conn = owner.get(id) ?? (await starting.get(id))
      owner.delete(id)
      if (conn) await withTimeout(conn.request({ t: 'kill', id }), 2000, null)
    },

    async killAll() {
      const served = new Set(owner.values())
      owner.clear()
      await Promise.all([...served].map(conn => withTimeout(conn.request({ t: 'killAll' }), 2000, null)))
    },

    close() {
      for (const conn of conns.values()) {
        conn.onClose = () => undefined
        conn.close()
      }
      conns.clear()
      owner.clear()
    },
  }
}
