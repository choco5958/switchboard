import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ko } from './i18n/ko'
import {
  PRESETS,
  agentBadges,
  agentLabel,
  checkedCustom,
  customLaunch,
  fillTemplate,
  presetLaunch,
  presetOf,
  psQuote,
  shellWord,
  showOtherAgents,
  trustFolders,
  validateCustom,
  type CustomAgent,
} from './agents'

const server = { command: '/opt/node/bin/node', args: ['/app/mcp/server.ts', '--agent', 'codex', '--terminal', 'a1b2c3-t1'] }
const file = '/home/u/.claude-ide/agents/a1b2c3-t1-codex.json'

// The words a shell makes of a line: what the CLI really receives.
function words(line: string): string[] {
  const script = `set -- ${line}; for w in "$@"; do printf '%s\\0' "$w"; done`
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).split('\0').slice(0, -1)
}

describe('preset launch lines', () => {
  it('codex gets the server through -c overrides of mcp_servers.switchboard, as TOML', () => {
    const launch = presetLaunch(presetOf('codex')!, server, file)
    expect(words(launch.line)).toEqual([
      'codex',
      '-c',
      "mcp_servers.switchboard.command='/opt/node/bin/node'",
      '-c',
      "mcp_servers.switchboard.args=['/app/mcp/server.ts','--agent','codex','--terminal','a1b2c3-t1']",
    ])
    expect([launch.env, launch.files]).toEqual([{}, []])
  })

  it('gemini reads a defaults file named by an env var; the file holds mcpServers.switchboard', () => {
    const launch = presetLaunch(presetOf('gemini')!, server, file)
    expect(launch.line).toBe('gemini')
    expect(launch.env).toEqual({ GEMINI_CLI_SYSTEM_DEFAULTS_PATH: file })
    expect(JSON.parse(launch.files[0]!.content)).toEqual({ mcpServers: { switchboard: { command: server.command, args: server.args, trust: true } } })
    expect(launch.files[0]!.path).toBe(file)
  })

  it('qwen, copilot and amp take a flag; opencode an env var; goose an extension command', () => {
    expect(words(presetLaunch(presetOf('qwen')!, server, file).line)).toEqual(['qwen', '--mcp-config', file])
    const copilot = presetLaunch(presetOf('copilot')!, server, file)
    expect(words(copilot.line)).toEqual(['copilot', '--additional-mcp-config', `@${file}`])
    expect(JSON.parse(copilot.files[0]!.content).mcpServers.switchboard).toMatchObject({ type: 'local', tools: ['*'] })
    const amp = words(presetLaunch(presetOf('amp')!, server, file).line)
    expect(amp.slice(0, 2)).toEqual(['amp', '--mcp-config'])
    expect(JSON.parse(amp[2]!)).toEqual({ switchboard: { command: server.command, args: server.args } })
    const opencode = presetLaunch(presetOf('opencode')!, server, file)
    expect(opencode.line).toBe('opencode')
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT!).mcp.switchboard.command).toEqual([server.command, ...server.args])
    expect(words(presetLaunch(presetOf('goose')!, server, file).line)).toEqual(['goose', 'session', '--with-extension', [server.command, ...server.args].join(' ')])
  })

  it('a CLI without a per-run way gets only its command', () => {
    for (const preset of PRESETS.filter(p => p.mcp === null)) {
      expect(presetLaunch(preset, server, file)).toEqual({ line: preset.bin, env: {}, files: [] })
    }
  })

  it('every preset has an install hint, a documentation link and a dictionary text for how it connects', () => {
    for (const preset of PRESETS) {
      expect(preset.install.length).toBeGreaterThan(5)
      expect(preset.docs).toMatch(/^https:\/\//)
      expect(preset.label).not.toMatch(/[\u2013\u2014\u00b7]/)
      expect(Object.hasOwn(ko, preset.how), preset.how).toBe(true)
    }
  })
})

describe('custom CLIs', () => {
  it('placeholders become quoted words the shell gives back as they were', () => {
    const spaced = { command: '/My Tools/node', args: ['/app dir/server.ts', '--agent', 'custom-x'] }
    const line = fillTemplate('--cmd {command} --args {args} --json {args_json} --file {config_file} --all {server} --name {name}', spaced, '/tmp/a b.json')
    expect(words(line)).toEqual([
      '--cmd', '/My Tools/node',
      '--args', '/app dir/server.ts', '--agent', 'custom-x',
      // Spaces in JSON on a command line are written \u0020 (PowerShell 5.1); it parses the same.
      '--json', JSON.stringify(spaced.args).replace(/ /g, '\\u0020'),
      '--file', '/tmp/a b.json',
      '--all', '/My Tools/node /app dir/server.ts --agent custom-x',
      '--name', 'switchboard',
    ])
  })

  it('an entry with a template writes the config file only when it is named; none runs the bare command', () => {
    const entry: CustomAgent = { id: 'custom-llama', name: 'Llama', command: 'mycli --model llama3', mcp: '--mcp-config {config_file}' }
    const launch = customLaunch(entry, server, file)
    expect(launch.line).toBe(`mycli --model llama3 --mcp-config ${file}`)
    expect(JSON.parse(launch.files[0]!.content).mcpServers.switchboard.args).toEqual(server.args)
    expect(customLaunch({ ...entry, mcp: 'none' }, server, file)).toEqual({ line: 'mycli --model llama3', env: {}, files: [] })
  })

  it('validation catches what would break, and gives a stable id', () => {
    const ok = validateCustom({ name: 'Local Llama', command: 'goose session', mcp: '--with-extension {server}' }, [])
    expect('entry' in ok && ok.entry).toEqual({ id: 'custom-local-llama', name: 'Local Llama', command: 'goose session', mcp: '--with-extension {server}' })
    const taken = 'entry' in ok ? [ok.entry] : []
    expect(validateCustom({ name: 'Local Llama', command: 'x', mcp: 'none' }, taken)).toHaveProperty('error')
    const second = validateCustom({ name: '로컬 라마', command: 'x', mcp: '' }, taken)
    expect('entry' in second && [second.entry.id, second.entry.mcp]).toEqual(['custom-cli', 'none'])
    expect(validateCustom({ name: 'a', command: 'x\nrm -rf /', mcp: 'none' }, [])).toHaveProperty('error')
    expect(validateCustom({ name: '', command: 'x', mcp: 'none' }, [])).toHaveProperty('error')
    expect(validateCustom({ name: 'Codex', command: 'x', mcp: 'none' }, [])).toHaveProperty('error')
    expect(validateCustom({ name: 'b', command: 'x', mcp: '--mcp {nope}' }, [])).toHaveProperty('error')
    expect(validateCustom({ name: 'b', command: 'x', mcp: '--mcp file.json' }, [])).toHaveProperty('error')
    expect(validateCustom({ name: 'b', command: 'x', mcp: "--mcp '{config_file}'" }, [])).toHaveProperty('error')
  })

  it('an entry is checked again before it runs: one the app would not have saved does not', () => {
    const saved: CustomAgent[] = [
      { id: 'custom-llama', name: 'Llama', command: 'goose session', mcp: 'none' },
      { id: 'custom-bad', name: 'Bad', command: 'x\nrm -rf ~', mcp: 'none' },
      { id: 'codex', name: 'Other', command: 'y', mcp: 'none' },
    ]
    expect(checkedCustom(saved, 'custom-llama')).toEqual(saved[0])
    expect(checkedCustom(saved, 'custom-bad')).toBeUndefined()
    expect(checkedCustom(saved, 'codex')).toBeUndefined()
    expect(checkedCustom(saved, 'custom-none')).toBeUndefined()
  })
})

describe('badges', () => {
  it('names presets, custom entries and Claude', () => {
    const customs: CustomAgent[] = [{ id: 'custom-llama', name: 'Llama', command: 'x', mcp: 'none' }]
    expect([agentLabel('codex'), agentLabel(undefined), agentLabel('claude'), agentLabel('custom-llama', customs), agentLabel('other')]).toEqual([
      'Codex', 'Claude', 'Claude', 'Llama', 'other',
    ])
  })

  it('show only once an agent other than Claude is around', () => {
    expect(agentBadges([{ id: 'a', agent: 'claude' }, { id: 'b' }])).toEqual({})
    expect(agentBadges([{ id: 'a', agent: 'claude' }, { id: 'b', agent: 'codex' }])).toEqual({ a: 'claude', b: 'codex' })
  })

  it('a shell word stays bare only when the shell would read it as it is', () => {
    expect([shellWord('-c'), shellWord('a b'), shellWord('x"y')]).toEqual(['-c', "'a b'", `'x"y'`])
  })

  it("PowerShell's typographic single quotes are doubled like the plain one", () => {
    expect(shellWord("it's", 'win32')).toBe("'it''s'")
    expect(shellWord('C:\\Users\\Jane\u2019s PC\\mod', 'win32')).toBe("'C:\\Users\\Jane\u2019\u2019s PC\\mod'")
    expect(psQuote('\u2018a\u2019 \u201ab\u201b "c"')).toBe("'\u2018\u2018a\u2019\u2019 \u201a\u201ab\u201b\u201b \\\"c\\\"'")
    // A folder with one in it cannot close the string and run what follows.
    const line = fillTemplate('--all {server}', { command: 'C:\\x\u2019; calc; \u2019\\node.exe', args: [] }, 'f.json', 'win32')
    expect(line).toBe("--all 'C:\\x\u2019\u2019; calc; \u2019\u2019\\node.exe'")
  })
})

describe('folder trust setting', () => {
  it('is off unless turned on', () => {
    expect([undefined, null, 'true', 1, false, true].map(trustFolders)).toEqual([false, false, false, false, false, true])
  })
})

describe('other agent buttons setting', () => {
  it('is on unless the stored value is exactly false', () => {
    expect([undefined, null, true, 'false', 0, false].map(showOtherAgents)).toEqual([true, true, true, true, true, false])
  })
})
