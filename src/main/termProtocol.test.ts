import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOfSocket, encode, hostSocket, keyMatches, lineReader, MAX_LINE, validBuild } from './termProtocol'
import { createCore, type Emulator, type Pty } from './termCore'
import { hostBuilds, hostSupported } from './termClient'

describe('the terminal host protocol', () => {
  it('reads messages split anywhere across chunks, several in one chunk, and skips lines that do not parse', () => {
    const got: unknown[] = []
    const read = lineReader(message => got.push(message), () => got.push('too long'))
    const text = encode({ t: 'data', id: 'k-t1', data: '한글\n줄' }) + 'not json\n\n' + encode({ t: 'exit', id: 'k-t1', code: 0 }) + '[1,2]\n'
    for (let i = 0; i < text.length; i += 3) read(text.slice(i, i + 3))
    expect(got).toEqual([
      { t: 'data', id: 'k-t1', data: '한글\n줄' },
      { t: 'exit', id: 'k-t1', code: 0 },
    ])
  })

  it('a line longer than any message of ours ends the reading', () => {
    let tooLong = 0
    const read = lineReader(() => undefined, () => tooLong++)
    read('x'.repeat(MAX_LINE + 1))
    expect(tooLong).toBe(1)
  })

  it('only the app key opens it', () => {
    const key = 'a'.repeat(64)
    expect(keyMatches(key, key)).toBe(true)
    expect(keyMatches('b'.repeat(64), key)).toBe(false)
    expect(keyMatches(key.slice(1), key)).toBe(false)
    expect(keyMatches(undefined, key)).toBe(false)
    expect(keyMatches('', '')).toBe(false)
  })

  it('a socket is named after its build, and only a build name makes one', () => {
    expect(hostSocket('/h/.claude-ide/termhosts', '0.3.4-abc123def456').replace(/\\/g, '/')).toBe('/h/.claude-ide/termhosts/0.3.4-abc123def456.sock')
    expect(buildOfSocket('0.3.4-abc123def456.sock')).toBe('0.3.4-abc123def456')
    expect(buildOfSocket('0.3.4.json')).toBe(null)
    expect(buildOfSocket('../x.sock')).toBe(null)
    expect(validBuild('0.3.4')).toBe(true)
    expect(validBuild('a/b')).toBe(false)
    expect(validBuild('')).toBe(false)
  })
})

// A pty that prints and ends on command.
function fakePty(front: { name: string }) {
  let onData: (data: string) => void = () => undefined
  let onExit: (event: { exitCode: number }) => void = () => undefined
  const written: string[] = []
  let killed = false
  const pty: Pty = {
    pid: 42,
    get process() {
      return front.name
    },
    write: data => written.push(data),
    resize: () => undefined,
    kill: () => {
      killed = true
      onExit({ exitCode: 129 })
    },
    onData: listener => (onData = listener),
    onExit: listener => (onExit = listener),
  }
  return { pty, print: (data: string) => onData(data), end: (code: number) => onExit({ exitCode: code }), written, killed: () => killed }
}

describe('the terminals core', () => {
  const request = (id: string) => ({ id, file: '/bin/zsh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, meta: { project: 'p', cwd: '/', title: 'codex', claude: false, agent: 'codex', shell: '/bin/zsh', bins: ['codex'] } })

  it('reports output, the program in front soon after it, and the end', async () => {
    const front = { name: 'zsh' }
    const fake = fakePty(front)
    const seen: string[] = []
    const core = createCore(() => fake.pty, {
      data: (id, data) => seen.push(`data ${id} ${data}`),
      exit: (id, code) => seen.push(`exit ${id} ${code}`),
      fg: (id, fg) => seen.push(`fg ${id} ${fg}`),
    }, { fgMs: 60_000 })
    expect(core.spawn(request('k-t1'))).toBe(42)
    front.name = 'codex'
    fake.print('hi')
    await new Promise(resolve => setTimeout(resolve, 150))
    fake.end(0)
    expect(seen).toEqual(['data k-t1 hi', 'fg k-t1 codex', 'exit k-t1 0'])
    expect(core.list()[0]).toMatchObject({ id: 'k-t1', alive: false, exitCode: 0, meta: { agent: 'codex' } })
    expect(core.aliveCount()).toBe(0)
    core.dispose()
  })

  it('a terminal closed on purpose is forgotten without an exit event', () => {
    const fake = fakePty({ name: 'zsh' })
    const seen: string[] = []
    const core = createCore(() => fake.pty, { data: () => undefined, exit: id => seen.push(id), fg: () => undefined })
    core.spawn(request('k-t1'))
    expect(() => core.spawn(request('k-t1'))).toThrow()
    expect(core.kill('k-t1')).toBe(true)
    expect(fake.killed()).toBe(true)
    expect(seen).toEqual([])
    expect(core.list()).toEqual([])
    core.dispose()
  })

  it('a snapshot is taken once everything printed before it is parsed', async () => {
    const fake = fakePty({ name: 'zsh' })
    let parsed = ''
    const pending: { data: string; done?: () => void }[] = []
    // An emulator that parses later, as xterm does.
    const emulator = (): Emulator => ({
      write: (data, done) => {
        pending.push({ data, done })
        setTimeout(() => {
          for (const one of pending.splice(0)) {
            parsed += one.data
            one.done?.()
          }
        }, 10)
      },
      resize: () => undefined,
      serialize: () => parsed,
      dispose: () => undefined,
    })
    const core = createCore(() => fake.pty, { data: () => undefined, exit: () => undefined, fg: () => undefined }, { emulator })
    core.spawn(request('k-t1'))
    fake.print('one ')
    fake.print('two')
    const snapshot = await core.snapshot('k-t1')
    expect(snapshot).toMatchObject({ id: 'k-t1', alive: true, screen: 'one two', cols: 80, rows: 24 })
    expect(await core.snapshot('nope')).toBe(null)
    core.dispose()
  })
})

describe('where a terminal host runs', () => {
  it('macOS and Linux with a key that lasts; never Windows, captures or when turned off', () => {
    expect(hostSupported('darwin', true, {})).toBe(true)
    expect(hostSupported('linux', true, { APPIMAGE: '/home/me/Switchboard.AppImage' })).toBe(true)
    expect(hostSupported('win32', true, {})).toBe(false)
    expect(hostSupported('darwin', false, {})).toBe(false)
    expect(hostSupported('darwin', true, { CLAUDE_IDE_CAPTURE: '/tmp/shot.png' })).toBe(false)
    expect(hostSupported('linux', true, { SWITCHBOARD_NO_TERMHOST: '1' })).toBe(false)
  })

  it('the builds whose host has a socket keep their runtime copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-hosts-'))
    writeFileSync(join(dir, '0.3.4-abc.sock'), '')
    writeFileSync(join(dir, 'termhost.log'), '')
    expect(hostBuilds(dir)).toEqual(['0.3.4-abc'])
    expect(hostBuilds(join(dir, 'none'))).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
