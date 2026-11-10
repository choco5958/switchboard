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
    // What it writes reads back as the folder, escapes and all.
    expect(codexTrustText(codexTrustText('', 'C:\\work\\"x"')!, 'C:\\work\\"x"')).toBeNull()
    expect(codexTrustText(codexTrustText('', '/w/a\n\u007f')!, '/w/a\n\u007f')).toBeNull()
  })

  it('Codex: knows the folder however the file writes it, so it never adds a second table', () => {
    // Codex writes a Windows folder as a literal string.
    const windows = "[projects.'C:\\Users\\me\\app']\r\ntrust_level = \"trusted\"\r\n"
    expect(codexTrustText(windows, 'C:\\Users\\me\\app')).toBeNull()
    expect(codexTrustText(windows, 'C:\\Users\\me\\other')).toContain('[projects."C:\\\\Users\\\\me\\\\other"]\r\n')
    expect(codexTrustText('[ projects . "/work/app" ] # mine\n', '/work/app')).toBeNull()
    expect(codexTrustText('[projects."/w\\u0061pp"]\n', '/wapp')).toBeNull()
    expect(codexTrustText('[projects]\n"/work/app" = { trust_level = "untrusted" }\n', '/work/app')).toBeNull()
    expect(codexTrustText('[projects]\n"/work/app".trust_level = "untrusted"\n', '/work/app')).toBeNull()
    expect(codexTrustText('projects."/work/app".trust_level = "trusted"\n', '/work/app')).toBeNull()
    expect(codexTrustText('[projects."/work/app".notes]\n', '/work/app')).toBeNull()
    // An inline `projects` table cannot take a table added below it.
    expect(codexTrustText('projects = { "/other" = { trust_level = "trusted" } }\n', '/work/app')).toBeNull()
    // Another folder, or a folder inside it, is not this one.
    expect(codexTrustText('[projects."/work/app/sub"]\n[projects."/work"]\n', '/work/app')).toContain('[projects."/work/app"]')
  })

  it('Codex: a header-like line inside a value is not a header', () => {
    const inString = (closer: string) => `[mcp_servers.x]\nargs = ["-c", '''\n[projects."/work/app"]\n${closer}]\n`
    expect(codexTrustText(inString("'''"), '/work/app')).toContain('[projects."/work/app"]\ntrust_level')
    // A run of four or five quotes still ends the string (the last one or two are its own).
    for (const closer of ["x''''", "x'''''"]) {
      const text = `${inString(closer)}[projects."/work/app"]\n`
      expect(codexTrustText(text, '/work/app')).toBeNull()
    }
    const basic = 'note = """\n[projects."/work/app"]\n\\""" still"""\n[projects."/work/app"]\n'
    expect(codexTrustText(basic, '/work/app')).toBeNull()
    expect(codexTrustText(basic.split('\n').slice(0, 3).join('\n') + '\n', '/work/app')).toContain('trust_level')
    const array = 'args = [\n  "a", # [projects."/work/app"]\n  "b",\n]\n'
    expect(codexTrustText(array, '/work/app')).toContain('trust_level')
  })

  it('Copilot: appends to trustedFolders, keeps other settings, refuses a file it cannot read', () => {
    const next = JSON.parse(copilotTrustText('{"model":"m","trustedFolders":["/a"]}', '/work/app')!)
    expect(next).toEqual({ model: 'm', trustedFolders: ['/a', '/work/app'] })
    expect(copilotTrustText('{"trustedFolders":["/work/app"]}', '/work/app')).toBeNull()
    expect(copilotTrustText('{not json', '/work/app')).toBeNull()
    expect(JSON.parse(copilotTrustText(null, '/w')!)).toEqual({ trustedFolders: ['/w'] })
    // Copilot 1.0.105 writes two comment lines first.
    const commented = '// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "firstLaunchAt": "x"\n}\n'
    const kept = copilotTrustText(commented, '/w')!
    expect(kept.startsWith('// User settings belong in settings.json.\n// This file is managed automatically.\n{')).toBe(true)
    expect(JSON.parse(kept.split('\n').slice(2).join('\n'))).toEqual({ firstLaunchAt: 'x', trustedFolders: ['/w'] })
    expect(copilotTrustText('// note\n{"trustedFolders":["/w"]}', '/w')).toBeNull()
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
