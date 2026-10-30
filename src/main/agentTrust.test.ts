import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentConfigIn, codexTrustText, copilotTrustText, cursorTrustFile, trustFolder } from './agentTrust'

const home = mkdtempSync(join(tmpdir(), 'sb-trust-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('folder trust written before a CLI opens', () => {
  it('Codex: adds the folder once, keeps the rest of config.toml, leaves a folder it names alone', () => {
    const before = 'model = "o5"\n\n[mcp_servers.x]\ncommand = "y"\n'
    const after = codexTrustText(before, '/work/app')!
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain('[projects."/work/app"]\ntrust_level = "trusted"\n')
    expect(codexTrustText(after, '/work/app')).toBeNull()
    expect(codexTrustText('[projects."/work/app"]\ntrust_level = "untrusted"\n', '/work/app')).toBeNull()
    expect(codexTrustText('', 'C:\\work\\"x"')).toBe('[projects."C:\\\\work\\\\\\"x\\""]\ntrust_level = "trusted"\n')
    // A line break in a folder name cannot start a table of its own.
    expect(codexTrustText('', '/w/a\n[mcp_servers.x]\u007f')).toBe('[projects."/w/a\\u000a[mcp_servers.x]\\u007f"]\ntrust_level = "trusted"\n')
  })

  it('Copilot: appends to trustedFolders, keeps other settings, refuses a file it cannot read', () => {
    const next = JSON.parse(copilotTrustText('{"model":"m","trustedFolders":["/a"]}', '/work/app')!)
    expect(next).toEqual({ model: 'm', trustedFolders: ['/a', '/work/app'] })
    expect(copilotTrustText('{"trustedFolders":["/work/app"]}', '/work/app')).toBeNull()
    expect(copilotTrustText('{not json', '/work/app')).toBeNull()
    expect(JSON.parse(copilotTrustText(null, '/w')!)).toEqual({ trustedFolders: ['/w'] })
  })

  it('Cursor: one marker file per folder', () => {
    expect(cursorTrustFile('/h', '/work/my app')).toBe('/h/.cursor/projects/work-my app/.workspace-trusted')
  })

  it('writes the files in a home, and does nothing for Claude Code or an unknown CLI', () => {
    const folder = mkdtempSync(join(tmpdir(), 'sb-trust-folder-'))
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o5"\n')
    trustFolder('codex', folder, home, {})
    trustFolder('copilot', folder, home, {})
    trustFolder('cursor', folder, home, {})
    trustFolder('claude', folder, home, {})
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('trust_level = "trusted"')
    expect(readFileSync(join(home, '.copilot', 'config.json'), 'utf8')).toContain('trustedFolders')
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    rmSync(folder, { recursive: true, force: true })
  })

  it('leaves alone a folder that brings agent config of its own', () => {
    const own = mkdtempSync(join(tmpdir(), 'sb-trust-own-'))
    const fresh = mkdtempSync(join(home, 'h-'))
    expect(agentConfigIn(own)).toBeNull()
    for (const [path, isDir] of [['.codex', true], ['.cursor', true], ['.mcp.json', false], ['.vscode/mcp.json', false], ['.github/copilot-instructions.md', false]] as const) {
      const folder = mkdtempSync(join(tmpdir(), 'sb-trust-cfg-'))
      const at = join(folder, path)
      mkdirSync(isDir ? at : join(at, '..'), { recursive: true })
      if (!isDir) writeFileSync(at, '{}')
      expect(agentConfigIn(folder)).toBe(path)
      trustFolder('codex', folder, fresh, {})
      trustFolder('copilot', folder, fresh, {})
      trustFolder('cursor', folder, fresh, {})
      rmSync(folder, { recursive: true, force: true })
    }
    expect(existsSync(join(fresh, '.codex', 'config.toml'))).toBe(false)
    expect(existsSync(join(fresh, '.copilot', 'config.json'))).toBe(false)
    expect(existsSync(join(fresh, '.cursor'))).toBe(false)
    rmSync(own, { recursive: true, force: true })
  })
})
