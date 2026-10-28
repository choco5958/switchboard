import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountDir, claudeLauncher, claudeLine } from './termAccount'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function file(): string {
  const dir = mkdtempSync('/tmp/cide-acct')
  dirs.push(dir)
  return join(dir, '.claude-ide', 'terminal.json')
}

describe('accountDir', () => {
  it('remembers the account folder the app was started with', () => {
    const path = file()
    expect(accountDir({ CLAUDE_CONFIG_DIR: '/acct/a' }, path)).toBe('/acct/a')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claudeConfigDir: '/acct/a' })
    expect(accountDir({}, path)).toBe('/acct/a')
  })

  it('never writes the file in a capture run', () => {
    const path = file()
    expect(accountDir({ CLAUDE_CONFIG_DIR: '/acct/test', CLAUDE_IDE_CAPTURE: '/tmp/x.png' }, path)).toBe('/acct/test')
    expect(existsSync(path)).toBe(false)
  })

  it('leaves the saved account alone in a capture run', () => {
    const path = file()
    accountDir({ CLAUDE_CONFIG_DIR: '/acct/real' }, path)
    accountDir({ CLAUDE_CONFIG_DIR: '/acct/test', CLAUDE_IDE_CAPTURE: '/tmp/x.png' }, path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claudeConfigDir: '/acct/real' })
  })

  it('falls back to the default on a broken file', () => {
    const path = file()
    accountDir({ CLAUDE_CONFIG_DIR: '/acct/a' }, path)
    writeFileSync(path, '{')
    expect(accountDir({}, path)).toBeUndefined()
  })
})

describe('claudeLauncher', () => {
  it('starts claude through ccr when ccr is on PATH or in ~/.local/bin', () => {
    const state = (p: string) => p.endsWith('/state/current')
    expect(claudeLauncher({ PATH: '/usr/bin:/opt/x/bin' }, p => p === '/opt/x/bin/ccr' || state(p))).toBe("'/opt/x/bin/ccr'")
    expect(claudeLauncher({ PATH: '' }, p => p.endsWith('/.local/bin/ccr') || state(p))).toMatch(/\/\.local\/bin\/ccr'$/)
  })
  it('plain claude when a ccr binary exists but has no state folder (another tool named ccr)', () => {
    expect(claudeLauncher({ PATH: '/opt/x/bin' }, p => p === '/opt/x/bin/ccr')).toBe('claude')
  })
  it('looks for the state folder under CCR_ROOT', () => {
    const env = { PATH: '/opt/x/bin', CCR_ROOT: '/r' }
    expect(claudeLauncher(env, p => p === '/opt/x/bin/ccr' || p === '/r/state/current')).toBe("'/opt/x/bin/ccr'")
  })
  it('plain claude without ccr, or when switched off', () => {
    expect(claudeLauncher({ PATH: '/usr/bin' }, () => false)).toBe('claude')
    expect(claudeLauncher({ PATH: '/opt/x/bin', SWITCHBOARD_NO_CCR: '1' }, () => true)).toBe('claude')
  })
})

describe('claudeLine', () => {
  const ccr = "'/u/.local/bin/ccr'"
  const dir = "'/app/mod'"

  it('pins the slot with ccr use before the run, and runs Claude even if use fails', () => {
    expect(claudeLine(ccr, dir, 3)).toBe(`${ccr} use 3; ${ccr} --plugin-dir ${dir}`)
  })

  it('starts as before without a slot, with a slot out of range, or a non integer', () => {
    const plain = `${ccr} --plugin-dir ${dir}`
    expect(claudeLine(ccr, dir)).toBe(plain)
    expect(claudeLine(ccr, dir, 0)).toBe(plain)
    expect(claudeLine(ccr, dir, 5)).toBe(plain)
    expect(claudeLine(ccr, dir, 1.5)).toBe(plain)
    expect(claudeLine(ccr, dir, Number('2; ls'))).toBe(plain)
  })

  it('ignores the slot when claude runs without ccr', () => {
    expect(claudeLine('claude', dir, 2)).toBe(`claude --plugin-dir ${dir}`)
  })
})
