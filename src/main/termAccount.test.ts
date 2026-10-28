import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountDir, claudeLauncher } from './termAccount'

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
    expect(claudeLauncher({ PATH: '/usr/bin:/opt/x/bin' }, p => p === '/opt/x/bin/ccr')).toBe("'/opt/x/bin/ccr'")
    expect(claudeLauncher({ PATH: '' }, p => p.endsWith('/.local/bin/ccr'))).toMatch(/\/\.local\/bin\/ccr'$/)
  })
  it('plain claude without ccr, or when switched off', () => {
    expect(claudeLauncher({ PATH: '/usr/bin' }, () => false)).toBe('claude')
    expect(claudeLauncher({ PATH: '/opt/x/bin', SWITCHBOARD_NO_CCR: '1' }, () => true)).toBe('claude')
  })
})
