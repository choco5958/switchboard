import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridge, listen } from '../../bridge/server.ts'
import type { Reply as BridgeReply } from '../shared/types'
import { QUIET_MS, type TypingTarget } from './agentInput'
import { startAgentDelivery } from './agentDelivery'
import { launchHost, legacyHost, openHost, terminalHosts, type HostConnection, type HostEvents, type LaunchOptions } from './termClient'
import { encode, hostSocket, newNonce, type Snapshot } from './termProtocol'

// Real hosts, run by Node as the app runs them with its own executable. Unix sockets only
// (the app keeps terminals in its own process on Windows).
const unix = process.platform !== 'win32'
const KEY = 'c'.repeat(64)
const ROOT = join(import.meta.dirname, '..', '..')
// Short: a socket path has a length limit (104 bytes on macOS), which the test HOME would pass.
const dir = unix ? mkdtempSync(join('/tmp', 'sbth-')) : ''
const pids = new Set<number>()

// TERMHOST_TEST_EXEC: another runtime for the hosts, such as Electron's executable (run as Node).
const options = (build: string, events?: Partial<HostEvents>): LaunchOptions & { events: HostEvents } => ({
  execPath: process.env.TERMHOST_TEST_EXEC || process.execPath,
  script: join(ROOT, 'src', 'main', 'termHost.ts'),
  build,
  dir,
  key: KEY,
  log: join(dir, 'termhost.log'),
  modules: ROOT,
  idleMs: 300,
  events: { data: () => undefined, exit: () => undefined, fg: () => undefined, lost: () => undefined, ...events },
})

const wait = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function connected(build: string, as = build): Promise<HostConnection> {
  const conn = await openHost(hostSocket(dir, build), KEY, as)
  if (typeof conn === 'string') throw new Error(`host ${build}: ${conn}`)
  pids.add(conn.pid)
  return conn
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  // Only the hosts these tests started, by their own pids.
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // Ended by itself.
    }
  }
  if (unix) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!unix)('the terminal host', () => {
  it('keeps a terminal while no app is attached, and shows it again to the next one', async () => {
    let output = ''
    const first = terminalHosts(options('build-a', { data: (_id, data) => (output += data) }))
    expect(await first.ready()).toBe(true)
    pids.add((await connected('build-a')).pid)
    const started = await first.spawn({
      id: 'run1-t1',
      file: '/bin/sh',
      args: ['-c', 'echo hi; read line; echo "got-$line"; sleep 30'],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
      meta: { project: 'proj', cwd: dir, title: 'codex', claude: false, agent: 'codex', shell: '/bin/sh', bins: ['codex'] },
    })
    expect(started).toMatchObject({ pid: expect.any(Number) })
    await wait(() => output.includes('hi'))
    // The app quits: its connection goes, the terminal stays.
    first.close()
    await new Promise(resolve => setTimeout(resolve, 600))

    let again = ''
    const found: Snapshot[] = []
    const second = terminalHosts(options('build-a', { data: (_id, data) => (again += data) }))
    await second.restore(snapshot => found.push(snapshot))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'run1-t1', alive: true, meta: { project: 'proj', title: 'codex', agent: 'codex', bins: ['codex'] } })
    expect(found[0]!.screen).toContain('hi')
    second.write('run1-t1', 'abc\r')
    await wait(() => again.includes('got-abc'))
    await second.kill('run1-t1')
    const conn = await connected('build-a')
    expect((await conn.request({ t: 'list' })).terms).toEqual([])
    conn.close()
    second.close()
  })

  it('a host that goes away takes its terminals with it, and the app hears of each', async () => {
    const lost: string[] = []
    const hosts = terminalHosts(options('build-crash', { lost: id => lost.push(id) }))
    expect(await hosts.ready()).toBe(true)
    const pid = (await connected('build-crash')).pid
    await hosts.spawn({ id: 'crash-t1', file: '/bin/sh', args: ['-c', 'sleep 30'], cwd: dir, env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24, meta: { project: 'p', cwd: dir, title: 'shell', claude: false, shell: '/bin/sh', bins: [] } })
    process.kill(pid, 'SIGKILL')
    await wait(() => lost.length > 0)
    expect(lost).toEqual(['crash-t1'])
    hosts.close()
  })

  it('ends once it has no terminal and no app', async () => {
    const hosts = terminalHosts(options('build-idle'))
    expect(await hosts.ready()).toBe(true)
    const conn = await connected('build-idle')
    conn.close()
    hosts.close()
    await wait(() => !alive(conn.pid) && !existsSync(hostSocket(dir, 'build-idle')))
    expect(readFileSync(join(dir, 'termhost.log'), 'utf8')).toContain('no terminals left; exiting')
  })

  it('refuses a connection without the app key', async () => {
    const hosts = terminalHosts(options('build-key'))
    expect(await hosts.ready()).toBe(true)
    expect(await openHost(hostSocket(dir, 'build-key'), 'd'.repeat(64), 'build-key')).toBe('refused')
    expect(await openHost(hostSocket(dir, 'nobody'), KEY, 'build-key')).toBe('dead')
    pids.add((await connected('build-key')).pid)
    hosts.close()
  })

  it('proves the key without sending it, and closes a connection that does not prove it soon', async () => {
    const hosts = terminalHosts({ ...options('build-proof'), env: { ...process.env, SWITCHBOARD_TERMHOST_AUTH_MS: '400' } })
    expect(await hosts.ready()).toBe(true)
    pids.add((await connected('build-proof')).pid)
    // What a connection gets and how long it stays open, for what it sends.
    const tryWith = (lines: string) =>
      new Promise<{ got: string; ms: number }>(resolve => {
        const started = Date.now()
        const socket = connect(hostSocket(dir, 'build-proof'))
        let got = ''
        socket.setEncoding('utf8')
        socket.on('connect', () => lines && socket.write(lines))
        socket.on('data', (chunk: string) => (got += chunk))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve({ got, ms: Date.now() - started }))
      })
    // The greeting of 0.3.5 carries the key itself: refused, nothing said back.
    expect((await tryWith(`${JSON.stringify({ t: 'hello', key: KEY, build: 'build-proof' })}\n`)).got).toBe('')
    // A hello gets the host's proof, never the key; with no proof back the connection goes.
    const silent = await tryWith(encode({ t: 'hello', build: 'build-proof', nonce: newNonce() }))
    expect(silent.got).toContain('"challenge"')
    expect(silent.got).not.toContain(KEY)
    expect(silent.ms).toBeLessThan(3000)
    // A wrong proof, a long line before the proof, and nothing at all are each refused.
    expect((await tryWith(encode({ t: 'hello', build: 'b', nonce: newNonce() }) + encode({ t: 'auth', proof: 'f'.repeat(64) }))).got).not.toContain('"hello"')
    expect((await tryWith('x'.repeat(8192))).got).toBe('')
    expect((await tryWith('')).ms).toBeLessThan(3000)
    hosts.close()
  })

  it('a program in a host\'s place gets no key: only a hello with a nonce, and no proof', async () => {
    const path = hostSocket(dir, 'build-squat')
    let got = ''
    const { createServer } = await import('node:net')
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        got += chunk
        // It makes up a challenge: the app does not answer it.
        socket.write(encode({ t: 'challenge', nonce: newNonce(), proof: '0'.repeat(64) }))
      })
    })
    await new Promise<void>(resolve => server.listen(path, resolve))
    expect(await openHost(path, KEY, 'build-x')).toBe('refused')
    expect(got).toContain('"nonce"')
    expect(got).not.toContain(KEY)
    expect(got).not.toContain('"auth"')
    server.close()
  })

  it('the app attaches to a host of 0.3.5 with its old greeting, and to nothing else that asks for the key', async () => {
    // A stand-in for 0.3.5's host: the old greeting, list and attach. `record` keeps what it got.
    const fake = (folder: string, name: string, build: string) => {
      const script = join(dir, folder, 'src', 'main', name)
      mkdirSync(join(dir, folder, 'src', 'main'), { recursive: true })
      writeFileSync(
        script,
        `const { createServer } = require('node:net')
const { appendFileSync, chmodSync } = require('node:fs')
const [path, key, record] = process.argv.slice(2)
const term = { id: 'legacy-t1', meta: { project: 'p', cwd: '/', title: 'shell', claude: false, shell: '/bin/sh', bins: [] }, alive: true, exitCode: null, fg: 'sh', lastOutput: 1, started: 1, cols: 80, rows: 24 }
const server = createServer(socket => {
  let buffer = ''
  let authed = false
  const send = message => socket.write(JSON.stringify(message) + '\\n')
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  socket.on('data', chunk => {
    appendFileSync(record, chunk)
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (!authed) {
        if (message.t !== 'hello' || message.key !== key) return socket.destroy()
        authed = true
        send({ t: 'hello', build: '${build}', pid: process.pid })
      } else if (message.t === 'list') send({ t: 'reply', rid: message.rid, ok: true, terms: [term] })
      else if (message.t === 'attach') send({ t: 'reply', rid: message.rid, ok: true, snapshot: { ...term, screen: 'old screen' } })
    }
  })
})
server.listen(path, () => chmodSync(path, 0o600))
`,
      )
      const record = join(dir, `${folder}.record`)
      writeFileSync(record, '')
      const child = spawn(process.execPath, [script, hostSocket(dir, build), KEY, record], { stdio: 'ignore' })
      pids.add(child.pid!)
      return record
    }
    const legacy = '0.3.5-abcdef012345'
    const record = fake('legacy', 'termHost.ts', legacy)
    await wait(() => existsSync(hostSocket(dir, legacy)))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await legacyHost(dir, legacy)).toBe(true)
    const found: Snapshot[] = []
    const hosts = terminalHosts(options('build-after'))
    await hosts.restore(snapshot => found.push(snapshot))
    expect(found.map(one => [one.id, one.screen])).toEqual([['legacy-t1', 'old screen']])
    expect(readFileSync(record, 'utf8')).toContain(KEY)
    hosts.close()

    // Named like one but run by another program: refused, and it never sees the key.
    const other = '0.3.5-0123456789ab'
    const squatted = fake('squat', 'server.ts', other)
    await wait(() => existsSync(hostSocket(dir, other)))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await legacyHost(dir, other)).toBe(false)
    // Open to others, or named after any other build: no old greeting either.
    chmodSync(hostSocket(dir, legacy), 0o666)
    expect(await legacyHost(dir, legacy)).toBe(false)
    chmodSync(hostSocket(dir, legacy), 0o600)
    expect(await legacyHost(dir, 'build-a')).toBe(false)
    const again = terminalHosts(options('build-after2'))
    const seen: Snapshot[] = []
    await again.restore(snapshot => seen.push(snapshot))
    expect(seen.map(one => one.id)).toEqual(['legacy-t1'])
    expect(readFileSync(squatted, 'utf8')).not.toContain(KEY)
    again.close()
  }, 20_000)

  it('a host of an older build takes no new terminal, keeps its own and goes when they end', async () => {
    launchHost(options('build-old'))
    await wait(() => existsSync(hostSocket(dir, 'build-old')))
    let old: HostConnection | null = null
    for (let i = 0; i < 40 && !old; i++) {
      const tried = await openHost(hostSocket(dir, 'build-old'), KEY, 'build-old')
      if (typeof tried !== 'string') old = tried
      else await new Promise(resolve => setTimeout(resolve, 50))
    }
    pids.add(old!.pid)
    const spawned = await old!.request({
      t: 'spawn',
      id: 'old-t1',
      file: '/bin/sh',
      args: ['-c', 'sleep 1'],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
      meta: { project: 'p', cwd: dir, title: 'shell', claude: false, shell: '/bin/sh', bins: [] },
    })
    expect(spawned.ok).toBe(true)
    old!.close()

    // The updated app attaches: the old host shows its terminal but starts none for it.
    const fresh = await connected('build-old', 'build-new')
    expect((await fresh.request({ t: 'list' })).terms?.map(term => term.id)).toEqual(['old-t1'])
    const refused = await fresh.request({ t: 'spawn', id: 'new-t1', file: '/bin/sh', args: [], cwd: dir, env: {}, cols: 80, rows: 24, meta: { project: 'p', cwd: dir, title: 'shell', claude: false, shell: '/bin/sh', bins: [] } })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('takes no new terminals') })
    // Its terminal ends; the old host goes although the new app is still attached.
    await wait(() => fresh.closed, 8000)
    expect(alive(fresh.pid)).toBe(false)
  })

  it('the answer typing types into a terminal the host runs', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'sb-hostdeliv-'))
    const socketPath = join(dbDir, 'bridge.sock')
    const bridge = createBridge(join(dbDir, 'ide.db'), undefined, { appKey: 'a'.repeat(64) })
    await listen(bridge.server, socketPath)
    const call = (method: string, path: string, body?: unknown): Promise<BridgeReply> =>
      new Promise(resolve => {
        const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', 'x-switchboard-app': 'a'.repeat(64) } }, res => {
          let text = ''
          res.on('data', chunk => (text += chunk))
          res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', error => resolve({ ok: false, status: 0, json: { error: error.message } }))
        if (body !== undefined) req.write(JSON.stringify(body))
        req.end()
      })

    // What terminals.ts keeps of a host terminal, from the host's events.
    const seen = { output: '', lastOutput: Date.now(), fg: '' }
    const hosts = terminalHosts(
      options('build-typing', {
        data: (_id, data) => {
          seen.output += data
          seen.lastOutput = Date.now()
        },
        fg: (_id, fg) => (seen.fg = fg),
      }),
    )
    expect(await hosts.ready()).toBe(true)
    pids.add((await connected('build-typing')).pid)
    // cat stands in for the CLI: it is the program in front and prints back what it gets.
    await hosts.spawn({ id: 'run2-t1', file: '/bin/cat', args: [], cwd: dir, env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24, meta: { project: 'p', cwd: dir, title: 'codex', claude: false, agent: 'codex', shell: '/bin/zsh', bins: ['cat'] } })
    // Linux names the program by its path (/bin/cat), macOS by its name.
    await wait(() => seen.fg.split('/').pop() === 'cat')
    const target: TypingTarget = {
      alive: true,
      shell: '/bin/zsh',
      get lastOutput() {
        return seen.lastOutput
      },
      paste: false,
      get foreground() {
        return seen.fg
      },
      expect: ['cat'],
      write: data => hosts.write('run2-t1', data),
    }
    await call('POST', '/settings', { key: 'lang', value: 'en' })
    await call('POST', '/sessions', { id: 'cx-host', cwd: dir, agent: 'codex', terminal: 'run2-t1' })
    const delivery = startAgentDelivery({ socketPath, call, terminal: key => (key === 'run2-t1' ? target : undefined), lang: () => 'en' })
    await delivery.refresh()
    expect(delivery.sessions()).toEqual(['cx-host'])
    const { json: q } = await call('POST', '/questions', { sessionId: 'cx-host', question: 'Ship it?', options: [{ key: 'a', label: 'Yes' }] })
    await call('POST', `/questions/${q.id}/answer`, { choice: 'a' })
    await wait(() => seen.output.includes(`Q${q.id}`), QUIET_MS + 5000)
    // Typed, then acknowledged: the bridge marks it delivered.
    let delivered = 0
    for (let i = 0; i < 50 && delivered !== 1; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const state = await call('GET', '/state')
      delivered = ((state.json.questions ?? []) as { id: number; delivered: number }[]).find(one => one.id === q.id)?.delivered ?? 0
    }
    expect(delivered).toBe(1)
    delivery.stop()
    await hosts.kill('run2-t1')
    hosts.close()
    bridge.close()
    rmSync(dbDir, { recursive: true, force: true })
  }, 20_000)
})
