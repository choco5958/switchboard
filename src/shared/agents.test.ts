import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ko } from './i18n/ko'
import { mcpTools } from '../../mcp/server'
import {
  PRESETS,
  agentBadges,
  agentLabel,
  checkedCustom,
  customLaunch,
  fillTemplate,
  presetLaunch,
  HOOK_TIMEOUT_S,
  EVENT_TIMEOUT_S,
  hookAttaches,
  hookCommand,
  codexHookOverrides,
  presetRun,
  qwenHookSettings,
  AGENTS,
  CLAUDE,
  agentOf,
  routineAgents,
  geminiExtension,
  geminiLaunch,
  presetOf,
  QWEN_DEFAULTS_ENV,
  SWITCHBOARD_TOOLS,
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

  it('codex with the relay on also gets its hooks, the same command for every run', () => {
    const hook = { command: '/home/p/.claude-ide/bin/switchboard-node', args: ['/r/mcp/hook.mjs', 'codex'] }
    const launch = presetLaunch(presetOf('codex')!, server, file, 'darwin', hook)
    const got = words(launch.line)
    const command = `command='/home/p/.claude-ide/bin/switchboard-node /r/mcp/hook.mjs codex'`
    // The permission ask, and the turn followed with a short timeout, each its own -c value.
    expect(got.slice(-10)).toEqual([
      '-c',
      `hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",${command},timeout=${HOOK_TIMEOUT_S}}]}]`,
      '-c',
      `hooks.UserPromptSubmit=[{hooks=[{type="command",${command},timeout=${EVENT_TIMEOUT_S}}]}]`,
      '-c',
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",${command},timeout=${EVENT_TIMEOUT_S}}]}]`,
      '-c',
      `hooks.PostToolUse=[{matcher="*",hooks=[{type="command",${command},timeout=${EVENT_TIMEOUT_S}}]}]`,
      '-c',
      `hooks.Stop=[{hooks=[{type="command",${command},timeout=${EVENT_TIMEOUT_S}}]}]`,
    ])
    expect(hookCommand(hook)).toBe('/home/p/.claude-ide/bin/switchboard-node /r/mcp/hook.mjs codex')
    // A quote in the path: a TOML basic string, which holds the shell's own quoting.
    expect(codexHookOverrides({ command: "/o'dd/node", args: ['/r/hook.mjs', 'codex'] })[0]).toContain(`command=${JSON.stringify("'/o'\\''dd/node' /r/hook.mjs codex")}`)
    // Gemini has no hook: the same line as without one.
    expect(presetLaunch(presetOf('gemini')!, server, file, 'darwin', hook).line).toBe('gemini')
  })

  it('qwen with the relay gets its hook in a system defaults file; a command holding $ gets none', () => {
    const hook = { command: '/home/p/.claude-ide/bin/switchboard-node', args: ['/r/mcp/hook.mjs', 'qwen'] }
    const launch = presetLaunch(presetOf('qwen')!, server, file, 'darwin', hook)
    const hookFile = file.replace(/\.json$/, '-hook.json')
    expect(launch.env).toEqual({ [QWEN_DEFAULTS_ENV]: hookFile })
    expect(launch.files.map(f => f.path)).toEqual([file, hookFile])
    const entry = JSON.parse(launch.files[1]!.content).hooks.PermissionRequest[0].hooks[0]
    // Qwen reads a command hook timeout of 1000 or more as milliseconds.
    expect(entry).toEqual({ type: 'command', command: '/home/p/.claude-ide/bin/switchboard-node /r/mcp/hook.mjs qwen', name: 'switchboard', timeout: HOOK_TIMEOUT_S * 1000 })
    expect(Object.keys(JSON.parse(launch.files[1]!.content).hooks)).toEqual(['PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
    expect(hookAttaches(presetOf('qwen')!, { ...hook, command: '/o$x/node' }, null)).toBe(false)
    const odd = presetLaunch(presetOf('qwen')!, server, file, 'darwin', { ...hook, command: '/o$x/node' })
    expect([odd.env, odd.files.length]).toEqual([{}, 1])
  })

  it('opencode 2 runs on a private server and gets the relay plugin beside the hook; opencode 1 neither', () => {
    const hook = { command: '/n/node', args: ['/r/mcp/hook.mjs', 'opencode'] }
    const two = presetLaunch(presetOf('opencode')!, server, file, 'darwin', hook, '2.2.5')
    expect(two.line).toBe('opencode --standalone')
    const config = JSON.parse(two.env.OPENCODE_CONFIG_CONTENT!)
    expect(config.plugins).toEqual(['/r/mcp/opencode'])
    expect(config.mcp.switchboard.command[0]).toBe(server.command)
    const one = presetLaunch(presetOf('opencode')!, server, file, 'darwin', hook, '1.19.5')
    expect(one.line).toBe('opencode')
    expect(JSON.parse(one.env.OPENCODE_CONFIG_CONTENT!).plugins).toBeUndefined()
    expect(presetLaunch(presetOf('opencode')!, server, file, 'darwin', undefined, null).line).toBe('opencode')
  })

  it('copilot from 1.0.105 gets a plugin folder of its own with the permission hook; an older one none', () => {
    const hook = { command: '/n/node', args: ['/r/mcp/hook.mjs', 'copilot'] }
    const launch = presetLaunch(presetOf('copilot')!, server, file, 'darwin', hook, '1.0.105')
    const dir = '/home/u/.claude-ide/agents/copilot-plugin'
    expect(words(launch.line)).toEqual(['copilot', '--additional-mcp-config', `@${file}`, '--plugin-dir', dir])
    expect(launch.files.map(f => f.path)).toEqual([file, `${dir}/plugin.json`, `${dir}/hooks.json`])
    expect(JSON.parse(launch.files[1]!.content).name).toBe('switchboard-approvals')
    const hooks = JSON.parse(launch.files[2]!.content).hooks
    expect(hooks.permissionRequest).toEqual([{ type: 'command', exec: '/n/node', args: ['/r/mcp/hook.mjs', 'copilot'], timeoutSec: HOOK_TIMEOUT_S }])
    // The turn too, with the same command and a short timeout.
    for (const name of ['userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop']) {
      expect(hooks[name]).toEqual([{ type: 'command', exec: '/n/node', args: ['/r/mcp/hook.mjs', 'copilot', name], timeoutSec: EVENT_TIMEOUT_S }])
    }
    expect([hookAttaches(presetOf('copilot')!, hook, '1.0.105'), hookAttaches(presetOf('copilot')!, hook, '1.0.104')]).toEqual([true, false])
    // A Windows path: the folder beside the run's file, backslashes and all.
    const win = presetLaunch(presetOf('copilot')!, server, 'C:\\Users\\u\\.claude-ide\\agents\\k-copilot.json', 'win32', hook, '1.0.105')
    expect(win.files.map(f => f.path).slice(1)).toEqual(['C:\\Users\\u\\.claude-ide\\agents/copilot-plugin/plugin.json', 'C:\\Users\\u\\.claude-ide\\agents/copilot-plugin/hooks.json'])
    for (const version of ['1.0.104', null]) {
      const older = presetLaunch(presetOf('copilot')!, server, file, 'darwin', hook, version)
      expect([words(older.line).includes('--plugin-dir'), older.files.length]).toEqual([false, 1])
    }
  })

  it('cursor gets one plugin folder every run shares, the key coming from its env', () => {
    const launch = presetLaunch(presetOf('cursor')!, server, file, 'darwin')
    const dir = '/home/u/.claude-ide/agents/cursor-plugin'
    expect(words(launch.line)).toEqual(['cursor-agent', '--plugin-dir', dir])
    expect(launch.files.map(f => f.path)).toEqual([`${dir}/.cursor-plugin/plugin.json`])
    const plugin = JSON.parse(launch.files[0]!.content)
    expect(plugin.name).toBe('switchboard')
    expect(plugin.mcpServers.switchboard).toEqual({
      command: server.command,
      args: ['/app/mcp/server.ts', '--agent', 'codex'],
      env: { SWITCHBOARD_TERMINAL: '${env:SWITCHBOARD_TERMINAL}' },
    })
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

  it('crush gets a data folder of the project whose crush.json adds the server and allows its tools', () => {
    const folder = '/home/u/.claude-ide/agents/crush/0123456789abcdef'
    const launch = presetLaunch(presetOf('crush')!, server, `${folder}/crush.json`)
    expect(words(launch.line)).toEqual(['crush', '-D', folder])
    expect(launch.files.map(f => f.path)).toEqual([`${folder}/crush.json`])
    const config = JSON.parse(launch.files[0]!.content)
    // No terminal key: every run in the project writes the same file, and the server reads the key
    // from SWITCHBOARD_TERMINAL.
    expect(config.mcp.switchboard).toEqual({ type: 'stdio', command: server.command, args: ['/app/mcp/server.ts', '--agent', 'codex'] })
    expect(config.permissions.allowed_tools).toContain('mcp_switchboard_ask_decision')
    expect(presetOf('crush')!.dataFolder).toBe(true)
    // What Crush's shell expansion would read: a plain terminal.
    // (A Windows path goes with forward slashes: the Windows tests below.)
    for (const odd of [{ ...server, command: '/o$x/node' }, { ...server, command: "/o'dd/node" }, { ...server, command: '/a\\b/node' }]) {
      expect(presetLaunch(presetOf('crush')!, odd, `${folder}/crush.json`)).toEqual({ line: 'crush', env: {}, files: [] })
    }
  })

  it('crush with the relay gets its hooks in the same crush.json, a shell line with nothing of a run', () => {
    const folder = '/home/u/.claude-ide/agents/crush/0123456789abcdef'
    const hook = { command: '/home/p/node', args: ['/r/mcp/hook.mjs', 'crush'] }
    const launch = presetLaunch(presetOf('crush')!, server, `${folder}/crush.json`, 'darwin', hook)
    expect(words(launch.line)).toEqual(['crush', '-D', folder])
    expect(launch.files.map(f => f.path)).toEqual([`${folder}/crush.json`])
    const config = JSON.parse(launch.files[0]!.content)
    expect(config.mcp.switchboard.command).toBe(server.command)
    const one = (timeout: number) => [{ name: 'switchboard', command: '/home/p/node /r/mcp/hook.mjs crush', timeout }]
    expect(config.hooks).toEqual({
      PreToolUse: one(HOOK_TIMEOUT_S),
      PostToolUse: one(EVENT_TIMEOUT_S),
      PostToolUseFailure: one(EVENT_TIMEOUT_S),
      TurnStart: one(EVENT_TIMEOUT_S),
      TurnEnd: one(EVENT_TIMEOUT_S),
      Interrupt: one(EVENT_TIMEOUT_S),
      StopFailure: one(EVENT_TIMEOUT_S),
    })
    expect(hookAttaches(presetOf('crush')!, hook, null)).toBe(true)
    // A server Crush could not be given: no hooks either.
    expect(presetLaunch(presetOf('crush')!, { ...server, command: '/o$x/node' }, `${folder}/crush.json`, 'darwin', hook).files).toEqual([])
  })

  it('gemini through its extension: the server and hooks hold nothing of a run, and the run gets a policy', () => {
    const shared = { command: '/opt/node', args: ['/app/mcp/server.mjs', '--agent', 'gemini', '--terminal', '', '--socket', '/h/b.sock', '--abilities', 'turnEnd'] }
    const files = geminiExtension(shared, { command: '/opt/node', args: ['/app/mcp/hook.mjs', 'gemini'] }, '/h/.claude-ide/agents/gemini-extension')
    expect(files.map(f => f.path)).toEqual(['/h/.claude-ide/agents/gemini-extension/gemini-extension.json', '/h/.claude-ide/agents/gemini-extension/hooks/hooks.json'])
    expect(files[0]!.value).toEqual({
      name: 'switchboard',
      version: '1.0.0',
      description: 'Switchboard',
      mcpServers: { switchboard: { command: '/opt/node', args: ['/app/mcp/server.mjs', '--agent', 'gemini', '--socket', '/h/b.sock', '--app-only'] } },
    })
    const hooks = (files[1]!.value as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> }).hooks
    expect(Object.keys(hooks)).toEqual(['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent'])
    expect(hooks.AfterAgent![0]!.hooks[0]).toMatchObject({ command: '/opt/node /app/mcp/hook.mjs gemini', timeout: EVENT_TIMEOUT_S * 1000 })
    // Without hooks (Windows), or a command Gemini would fill ${…} in: none.
    expect(geminiExtension(shared, undefined, '/x')[1]!.value).toEqual({ hooks: {} })
    expect(geminiExtension(shared, { command: '/o${x}/node', args: [] }, '/x')[1]!.value).toEqual({ hooks: {} })
    const launch = geminiLaunch('/h/.claude-ide/agents/k1-gemini.toml', ['turnEnd', 'activity', 'prompt'], 'darwin')
    expect(launch.line).toBe('gemini --policy /h/.claude-ide/agents/k1-gemini.toml')
    expect(launch.env).toEqual({ SWITCHBOARD_ABILITIES: 'turnEnd,activity,prompt', SWITCHBOARD_EXTENSION: '1' })
    expect(launch.files[0]!.content).toBe('[[rule]]\ntoolName = "*"\nmcpName = "switchboard"\ndecision = "allow"\npriority = 100\n')
  })

  it('Claude Code is listed and named as the others are, but never opened as a per-run MCP CLI', () => {
    expect(AGENTS[0]).toBe(CLAUDE)
    expect(AGENTS.slice(1)).toEqual(PRESETS)
    expect(agentOf('claude')?.via).toBe('mod')
    // agentTerms.ts opens what presetOf finds: Claude Code goes through terminals.ts and the mod.
    expect(presetOf('claude')).toBeUndefined()
    expect(routineAgents(null, [])[0]).toEqual({ id: 'claude', label: 'Claude Code' })
  })

  it('the tools a CLI is told to allow are the server\'s tools', () => {
    expect([...SWITCHBOARD_TOOLS].sort()).toEqual(mcpTools('en').map(tool => tool.name).sort())
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

describe('hook commands on Windows', () => {
  // A default Node install and a home with a space, as a Windows PC often has.
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const script = 'C:\\Users\\Dae Hyeon\\.claude-ide\\runtime\\b1\\out\\node\\mcp\\hook.mjs'
  const hook = (agent: string) => ({ command: node, args: [script, agent] })

  it('Codex runs its hooks with cmd.exe /C: double quotes, and none for a word that cmd would read', () => {
    expect(hookCommand(hook('codex'), 'cmd')).toBe(`"${node}" "${script}" codex`)
    expect(codexHookOverrides(hook('codex'), 'win32')[0]).toContain(`command='"${node}" "${script}" codex'`)
    expect(codexHookOverrides(hook('codex'), 'win32')).toHaveLength(5)
    const odd = { command: node, args: ['C:\\100%\\hook.mjs', 'codex'] }
    expect(codexHookOverrides(odd, 'win32')).toEqual([])
    expect(hookAttaches(presetOf('codex')!, odd, null, 'win32')).toBe(false)
    // Elsewhere the same POSIX words as before.
    expect(codexHookOverrides(hook('codex'), 'linux')[0]).toContain(`command=${JSON.stringify(hookCommand(hook('codex')))}`)
  })

  it('Qwen and Gemini run them in PowerShell, Qwen because the hook names it', () => {
    const qwen = qwenHookSettings(hook('qwen'), 'win32') as { hooks: Record<string, { hooks: { command: string; shell?: string }[] }[]> }
    const command = `& '${node}' '${script}' qwen`
    // (a word PowerShell reads as it is stays bare)
    for (const event of Object.values(qwen.hooks)) expect(event[0]!.hooks[0]).toMatchObject({ command, shell: 'powershell' })
    expect((qwenHookSettings(hook('qwen'), 'darwin') as typeof qwen).hooks.Stop![0]!.hooks[0]!.shell).toBeUndefined()
    const shared = { command: node, args: ['C:\\app\\mcp\\server.mjs', '--agent', 'gemini', '--terminal', ''] }
    const gemini = geminiExtension(shared, hook('gemini'), 'C:\\x', 'win32')[1]!.value as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect(gemini.hooks.BeforeAgent![0]!.hooks[0]!.command).toBe(`& '${node}' '${script}' gemini`)
  })

  it("Crush's own POSIX shell runs them on every OS, its Windows paths with forward slashes", () => {
    const winServer = { command: node, args: ['C:\\Users\\Dae Hyeon\\mcp\\server.mjs', '--agent', 'crush', '--terminal', 't1'] }
    const run = presetRun(presetOf('crush')!, winServer, 'C:\\Users\\Dae Hyeon\\.claude-ide\\agents\\crush\\p1\\crush.json', 'win32', hook('crush'))
    expect(run.args).toEqual(['-D', 'C:/Users/Dae Hyeon/.claude-ide/agents/crush/p1'])
    const config = JSON.parse(run.files[0]!.content) as { mcp: { switchboard: { command: string; args: string[] } }; hooks: Record<string, { command: string }[]> }
    expect(config.mcp.switchboard).toMatchObject({ command: 'C:/Program Files/nodejs/node.exe', args: ['C:/Users/Dae Hyeon/mcp/server.mjs', '--agent', 'crush'] })
    expect(config.hooks.PreToolUse![0]!.command).toBe(`'C:/Program Files/nodejs/node.exe' 'C:/Users/Dae Hyeon/.claude-ide/runtime/b1/out/node/mcp/hook.mjs' crush`)
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
