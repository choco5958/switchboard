import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { buildId, contentHash, copyRuntime, nodeLauncher, oldBridgePid, pruneRuntimes, runtimeFiles, staleBridge, writeRuntime } from './runtime'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the launchers point at this copy of the app and its Node', () => {
  const files = runtimeFiles({ execPath: "/Applications/Switch board's.app/Contents/MacOS/Switchboard", root: '/R/node', home: '/H', version: '0.2.0', platform: 'darwin' })
  expect(files.map(f => f.path.replace(/\\/g, '/'))).toEqual(['/H/.claude-ide/bin/switchboard-node', '/H/.claude-ide/start-bridge.json', '/H/.claude-ide/start-bridge.sh', '/H/.local/bin/switchboard'])
  expect(files[0]!.content).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/Switch board'\\''s.app/Contents/MacOS/Switchboard' "$@"`)
  expect(JSON.parse(files[1]!.content)).toEqual({
    argv: ["/Applications/Switch board's.app/Contents/MacOS/Switchboard", '/R/node/bridge/start.ts'],
    env: { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_VERSION: '0.2.0' },
  })
  expect(files[2]!.content).toContain(`SWITCHBOARD_VERSION='0.2.0' exec '/H/.claude-ide/bin/switchboard-node' '/R/node/bridge/start.ts'`)
  expect(files[3]!.content).toContain(`exec '/H/.claude-ide/bin/switchboard-node' '/R/node/scripts/switchboard.ts' "$@"`)
})

test('on Windows the launchers are .cmd files and the switchboard command waits in bin', () => {
  const files = runtimeFiles({ execPath: 'C:/Program Files/Switchboard/Switchboard.exe', root: 'C:/Users/me/.claude-ide/runtime/0.2.0', home: 'C:/Users/me', version: '0.2.0', platform: 'win32' })
  expect(files.map(f => f.path.replace(/\\/g, '/').split('.claude-ide')[1])).toEqual(['/bin/switchboard-node.cmd', '/start-bridge.json', '/start-bridge.cmd', '/bin/switchboard.cmd'])
  expect(files[0]!.content).toBe('@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:/Program Files/Switchboard/Switchboard.exe" %*\r\n')
  expect(files[3]!.content).toContain('"C:/Program Files/Switchboard/Switchboard.exe" "C:\\Users\\me\\.claude-ide\\runtime\\0.2.0\\scripts\\switchboard.ts" %*')
})

// Mode bits and running a shell script: macOS and Linux (the .cmd text is checked above).
test.skipIf(process.platform === 'win32')('written launchers run: the Node one runs a script with the executable it names', () => {
  const home = mkdtempSync(join(tmpdir(), 'sb-runtime-'))
  dirs.push(home)
  writeRuntime({ execPath: process.execPath, root: '/R', home, version: '1' })
  expect(statSync(nodeLauncher(home)).mode & 0o777).toBe(0o755)
  expect(statSync(join(home, '.claude-ide')).mode & 0o777).toBe(0o700)
  expect(execFileSync(nodeLauncher(home), ['-e', 'console.log(1 + 1)'], { encoding: 'utf8' }).trim()).toBe('2')
  expect(readFileSync(join(home, '.claude-ide', 'start-bridge.sh'), 'utf8')).toMatch(/^#!\/bin\/sh\n/)
})

test('a running bridge of another version is replaced; an unknown one is left alone', () => {
  expect(staleBridge({ ok: true, version: '0.1.0', pid: 42 }, '0.2.0')).toBe(42)
  expect(staleBridge({ ok: true, version: '0.2.0', pid: 42 }, '0.2.0')).toBe(null)
  expect(staleBridge({ ok: true }, '0.2.0')).toBe(null)
})

test.skipIf(process.platform === 'win32')('a bridge without a pid is found by its socket, and only when it runs bridge/server.ts', async () => {
  const seen = (lsof: string, command: string) => (file: string) => Promise.resolve(file === 'lsof' ? lsof : command)
  expect(await oldBridgePid('/H/.claude-ide/bridge.sock', seen('4242\n', '/usr/bin/node /src/claude-ide/bridge/server.ts\n'))).toBe(4242)
  expect(await oldBridgePid('/s', seen('4242\n', '/usr/bin/node /src/other/server.ts'))).toBe(null)
  expect(await oldBridgePid('/s', seen('4242\n4243\n', '/usr/bin/node /src/bridge/server.ts'))).toBe(null)
  expect(await oldBridgePid('/s', seen('', ''))).toBe(null)
})

test('each version gets one copy of the Node side, and older copies go', () => {
  const home = mkdtempSync(join(tmpdir(), 'sb-runtime-'))
  dirs.push(home)
  const source = join(home, 'Resources', 'node')
  mkdirSync(join(source, 'bridge'), { recursive: true })
  writeFileSync(join(source, 'bridge', 'server.ts'), 'v1')
  const first = copyRuntime(source, home, '0.1.0')
  expect(readFileSync(join(first, 'bridge', 'server.ts'), 'utf8')).toBe('v1')
  writeFileSync(join(source, 'bridge', 'server.ts'), 'v2')
  expect(copyRuntime(source, home, '0.1.0')).toBe(first)
  expect(readFileSync(join(first, 'bridge', 'server.ts'), 'utf8')).toBe('v1')
  const second = copyRuntime(source, home, '0.2.0')
  expect(readFileSync(join(second, 'bridge', 'server.ts'), 'utf8')).toBe('v2')
  expect(existsSync(first)).toBe(true)
  pruneRuntimes(home, '0.2.0')
  expect(existsSync(first)).toBe(false)
})

test('a rebuild of the same version is a build of its own: its copy and its bridge replace the old ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'sb-runtime-'))
  dirs.push(home)
  const source = join(home, 'Resources', 'node')
  mkdirSync(join(source, 'mod', 'hooks'), { recursive: true })
  writeFileSync(join(source, 'mod', 'hooks', 'register.ts'), 'v1')
  const first = buildId(source, '0.3.4')
  expect(first).toMatch(/^0\.3\.4-[0-9a-f]{12}$/)
  expect(buildId(source, '0.3.4')).toBe(first)
  const before = copyRuntime(source, home, first)
  writeFileSync(join(source, 'mod', 'hooks', 'register.ts'), 'v2')
  const second = buildId(source, '0.3.4')
  expect(second).not.toBe(first)
  const after = copyRuntime(source, home, second)
  expect(readFileSync(join(after, 'mod', 'hooks', 'register.ts'), 'utf8')).toBe('v2')
  pruneRuntimes(home, second)
  expect(existsSync(before)).toBe(false)
  // The bridge the first build started says its build: the second replaces it.
  expect(staleBridge({ ok: true, version: first, pid: 42 }, second)).toBe(42)
  expect(staleBridge({ ok: true, version: second, pid: 42 }, second)).toBe(null)
  // A file renamed with the same bytes is a change too.
  const renamed = contentHash(source)
  writeFileSync(join(source, 'mod', 'hooks', 'other.ts'), 'v2')
  rmSync(join(source, 'mod', 'hooks', 'register.ts'))
  expect(contentHash(source)).not.toBe(renamed)
})
