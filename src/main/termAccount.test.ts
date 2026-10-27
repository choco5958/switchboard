import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountDir } from './termAccount'

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
