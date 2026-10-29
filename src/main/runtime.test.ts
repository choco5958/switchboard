import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { copyRuntime, nodeLauncher, runtimeFiles, staleBridge, writeRuntime } from './runtime'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the launchers point at this copy of the app and its Node', () => {
  const files = runtimeFiles({ execPath: "/Applications/Switch board's.app/Contents/MacOS/Switchboard", root: '/R/node', home: '/H', version: '0.2.0' })
  expect(files.map(f => f.path)).toEqual(['/H/.claude-ide/bin/switchboard-node', '/H/.claude-ide/start-bridge.sh', '/H/.local/bin/switchboard'])
  expect(files[0]!.content).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/Switch board'\\''s.app/Contents/MacOS/Switchboard' "$@"`)
  expect(files[1]!.content).toContain(`SWITCHBOARD_VERSION='0.2.0' nohup '/H/.claude-ide/bin/switchboard-node' '/R/node/bridge/server.ts'`)
  expect(files[2]!.content).toContain(`exec '/H/.claude-ide/bin/switchboard-node' '/R/node/scripts/switchboard.ts' "$@"`)
})

test('written launchers run: the Node one runs a script with the executable it names', () => {
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
  expect(existsSync(first)).toBe(false)
})
