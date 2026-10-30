// The terminal host: a process of its own that runs the app's terminals (termCore.ts), so
// quitting, restarting or updating the app never ends the work running in them. The app
// starts it detached on its own executable in Node mode (termClient.ts launchHost), gives it
// the app's key on standard input and talks to it over a Unix socket (termProtocol.ts) that
// only answers a connection proving that key, after proving it first itself.
//
// Each build of the app has its own host. A host takes new terminals only from an app of its
// own build: after an update its files may be gone (macOS replaces the bundle, and node-pty's
// spawn-helper lives there), but what it loaded at its start keeps serving the terminals it
// has. It ends once it has no running terminal and no app attached, or, once a newer app has
// attached, as soon as its last terminal ends.
//
// It loads everything at its start: node-pty and the screen emulator from the app's own files
// (SWITCHBOARD_MODULES, by default the app.asar beside this executable), so nothing is read
// from a bundle an update has since replaced.

import { createServer, connect, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createCore, type Emulator, type SpawnPty } from './termCore.ts'
import { AUTH_MS, encode, hostSocket, keyMatches, lineReader, MAX_GREETING, MAX_LINE, newNonce, proof, validBuild, validNonce, type Message, type SpawnRequest, type TermMeta } from './termProtocol.ts'

type HeadlessModule = typeof import('@xterm/headless')
type SerializeModule = typeof import('@xterm/addon-serialize')

// What an app sees of a terminal after it attaches again: enough to scroll back through the
// work it missed.
const SCROLLBACK = 2000
// An app that reads far slower than its terminals print is dropped; it attaches again.
const MAX_QUEUED = 32 * 1024 * 1024

export type HostConfig = {
  build: string
  dir: string
  key: string
  // The folder whose node_modules hold node-pty, @xterm/headless and @xterm/addon-serialize.
  modules: string
  idleMs: number
  // How long a connection has to prove the key (termProtocol.ts AUTH_MS; shorter in tests).
  authMs?: number
}

function log(...parts: unknown[]): void {
  console.error(new Date().toISOString(), ...parts)
}

function emulatorWith(headless: HeadlessModule, serialize: SerializeModule): (cols: number, rows: number) => Emulator {
  return (cols, rows) => {
    const term = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true, logLevel: 'off' })
    const serializer = new serialize.SerializeAddon()
    term.loadAddon(serializer as unknown as Parameters<typeof term.loadAddon>[0])
    return {
      write: (data, done) => term.write(data, done),
      resize: (c, r) => term.resize(Math.max(2, c), Math.max(1, r)),
      // The addon leaves the cursor where its last cell went; the program expects it where it was.
      serialize: () => {
        const text = serializer.serialize()
        const buffer = term.buffer.active
        return text ? `${text}\x1b[${buffer.cursorY + 1};${Math.min(buffer.cursorX, term.cols - 1) + 1}H` : text
      },
      dispose: () => term.dispose(),
    }
  }
}

type Client = {
  socket: Socket
  authed: boolean
  // The greeting's nonces, set once the app said hello and the host answered.
  nonces: { app: string; host: string } | null
  build: string
  // Terminals whose output this app gets.
  subs: Set<string>
  // Terminals being attached: what they print meanwhile waits for the snapshot to go first.
  attaching: Map<string, Message[]>
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function spawnRequest(message: Record<string, unknown>): SpawnRequest | null {
  const meta = message.meta as Partial<TermMeta> | undefined
  const env = message.env
  if (!str(message.id) || !str(message.file) || !Array.isArray(message.args) || !str(message.cwd) || !meta || typeof env !== 'object' || env === null) return null
  return {
    id: str(message.id),
    file: str(message.file),
    args: message.args.map(String),
    cwd: str(message.cwd),
    env: Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
    cols: Math.max(20, num(message.cols) || 100),
    rows: Math.max(5, num(message.rows) || 30),
    meta: {
      project: str(meta.project),
      cwd: str(meta.cwd),
      title: str(meta.title),
      claude: meta.claude === true,
      agent: typeof meta.agent === 'string' ? meta.agent : undefined,
      shell: str(meta.shell),
      bins: Array.isArray(meta.bins) ? meta.bins.map(String) : [],
    },
  }
}

// Whether a host already answers on this socket: a second one of the same build must not take it over.
function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export async function runHost(config: HostConfig): Promise<void> {
  const require = createRequire(join(config.modules, 'package.json'))
  const pty = require('node-pty') as { spawn: SpawnPty }
  const headless = require('@xterm/headless') as HeadlessModule
  const serialize = require('@xterm/addon-serialize') as SerializeModule

  const clients = new Set<Client>()
  // A newer app attached: this host takes nothing new and goes once its terminals end.
  let retired = false

  const deliver = (id: string, message: Message) => {
    for (const client of clients) {
      const waiting = client.attaching.get(id)
      if (waiting) waiting.push(message)
      else if (client.subs.has(id)) send(client, message)
    }
  }

  const core = createCore(pty.spawn, {
    data: (id, data) => deliver(id, { t: 'data', id, data }),
    exit: (id, code) => {
      log(`terminal ${id} ended (${code})`)
      deliver(id, { t: 'exit', id, code })
    },
    fg: (id, fg) => deliver(id, { t: 'fg', id, fg }),
  }, { emulator: emulatorWith(headless, serialize) })

  function send(client: Client, message: Message): void {
    if (client.socket.destroyed) return
    if (client.socket.writableLength > MAX_QUEUED) {
      log('an app is not reading; dropping it')
      client.socket.destroy()
      return
    }
    client.socket.write(encode(message))
  }

  const reply = (client: Client, rid: unknown, fields: Partial<Extract<Message, { t: 'reply' }>> = {}) =>
    send(client, { t: 'reply', rid: num(rid), ok: fields.error === undefined, ...fields })

  function handle(client: Client, message: Record<string, unknown>): void {
    if (!client.authed) {
      const refuse = () => {
        log('refused a connection without the app key')
        client.socket.destroy()
      }
      // The app's hello: answered with this host's proof, which the app checks before its own.
      if (!client.nonces) {
        if (message.t !== 'hello' || !validNonce(message.nonce) || 'key' in message) return refuse()
        client.nonces = { app: message.nonce, host: newNonce() }
        client.build = str(message.build)
        send(client, { t: 'challenge', nonce: client.nonces.host, proof: proof(config.key, 'host', client.nonces.app, client.nonces.host) })
        return
      }
      if (message.t !== 'auth' || !keyMatches(message.proof, proof(config.key, 'app', client.nonces.app, client.nonces.host))) return refuse()
      client.authed = true
      if (client.build !== config.build && !retired) {
        retired = true
        log(`an app of build ${client.build} attached; taking no new terminals`)
      }
      send(client, { t: 'hello', build: config.build, pid: process.pid })
      return
    }
    const id = str(message.id)
    switch (message.t) {
      case 'spawn': {
        if (client.build !== config.build) return reply(client, message.rid, { error: `the terminal host of build ${config.build} takes no new terminals` })
        const request = spawnRequest(message)
        if (!request) return reply(client, message.rid, { error: 'bad spawn request' })
        try {
          const pid = core.spawn(request)
          client.subs.add(request.id)
          log(`terminal ${request.id} started (pid ${pid}) in ${request.cwd}`)
          return reply(client, message.rid, { pid })
        } catch (error) {
          return reply(client, message.rid, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      case 'write':
        return core.write(id, str(message.data))
      case 'resize':
        return core.resize(id, num(message.cols), num(message.rows))
      case 'kill':
        log(`terminal ${id} closed by the app`)
        core.kill(id)
        for (const one of clients) one.subs.delete(id)
        return reply(client, message.rid)
      case 'killAll':
        log('all terminals closed by the app')
        core.killAll()
        for (const one of clients) one.subs.clear()
        return reply(client, message.rid)
      case 'list':
        return reply(client, message.rid, { terms: core.list() })
      case 'attach': {
        if (!core.has(id)) return reply(client, message.rid, { error: `no terminal ${id}` })
        client.attaching.set(id, [])
        void core.snapshot(id).then(snapshot => {
          const waiting = client.attaching.get(id) ?? []
          client.attaching.delete(id)
          if (!snapshot) return reply(client, message.rid, { error: `no terminal ${id}` })
          client.subs.add(id)
          reply(client, message.rid, { snapshot })
          for (const queued of waiting) send(client, queued)
        })
        return
      }
    }
  }

  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  chmodSync(config.dir, 0o700)
  const path = hostSocket(config.dir, config.build)
  if (await answers(path)) {
    log(`a terminal host of build ${config.build} already runs; leaving it`)
    process.exit(0)
  }
  rmSync(path, { force: true })

  const server = createServer(socket => {
    const client: Client = { socket, authed: false, nonces: null, build: '', subs: new Set(), attaching: new Map() }
    clients.add(client)
    socket.setEncoding('utf8')
    const read = lineReader(
      message => handle(client, message),
      () => socket.destroy(),
      () => (client.authed ? MAX_LINE : MAX_GREETING),
    )
    // One that does not prove the key in time holds nothing open.
    const timer = setTimeout(() => {
      if (!client.authed) socket.destroy()
    }, config.authMs ?? AUTH_MS)
    socket.on('data', (chunk: string) => read(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(timer)
      clients.delete(client)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  chmodSync(path, 0o600)
  const inode = statSync(path).ino
  log(`terminal host ${config.build} listening (pid ${process.pid})`)

  // Ends once nothing runs and nobody would miss it, after a grace: an app that restarts
  // attaches again within it.
  let idleSince = 0
  setInterval(() => {
    const apps = [...clients].filter(one => one.authed).length
    const idle = core.aliveCount() === 0 && (retired || apps === 0)
    if (!idle) {
      idleSince = 0
      return
    }
    idleSince ||= Date.now()
    if (Date.now() - idleSince < config.idleMs) return
    log('no terminals left; exiting')
    core.dispose()
    server.close()
    try {
      // Only our own socket: a host started after this one may have taken the path.
      if (statSync(path).ino === inode) rmSync(path, { force: true })
    } catch {
      // Gone already.
    }
    process.exit(0)
  }, Math.min(1000, config.idleMs)).unref?.()
  // The interval above is unref'd; the server keeps the process alive.
}

// The app's key comes on standard input, never in the environment or a file another program reads.
async function keyFromStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += String(chunk)
    if (text.includes('\n') || text.length > 200) break
  }
  return text.split('\n')[0]!.trim()
}

if (import.meta.main) {
  // A bug in one request must not end every terminal: they all go with this process.
  process.on('uncaughtException', error => log('uncaught:', error))
  process.on('unhandledRejection', error => log('unhandled:', error))
  // No terminal of its own to hang up with; started detached, but kept from an inherited one too.
  process.on('SIGHUP', () => undefined)
  const build = process.env.SWITCHBOARD_TERMHOST_BUILD
  const dir = process.env.SWITCHBOARD_TERMHOST_DIR
  const key = await keyFromStdin()
  if (!validBuild(build) || !dir || !/^[0-9a-f]{64}$/.test(key)) {
    log('started without a build, a folder or the app key')
    process.exit(1)
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath
  const modules = process.env.SWITCHBOARD_MODULES || (resources ? join(resources, 'app.asar') : '')
  try {
    await runHost({ build, dir, key, modules, idleMs: Number(process.env.SWITCHBOARD_TERMHOST_IDLE_MS) || 60_000, authMs: Number(process.env.SWITCHBOARD_TERMHOST_AUTH_MS) || AUTH_MS })
  } catch (error) {
    log('could not start:', error)
    process.exit(1)
  }
}
