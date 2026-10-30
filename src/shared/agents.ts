import { shellQuote } from './projects'
import { t, type Key } from './i18n'

// Agent CLIs besides Claude Code. Each preset knows how to hand the CLI the
// Switchboard MCP server (mcp/server.ts) for one run only: a flag, an env var on the
// process, or a JSON file in the app's own folder that a flag or env var points at.
// None of them touches the CLI's own config (~/.codex, ~/.gemini and so on).

export const MCP_NAME = 'switchboard'

// The server as a command: node and the server script with --agent and --terminal.
export type McpServer = { command: string; args: string[] }

// What the main process does to start one: the line typed into the shell, env vars for
// the shell, and files to write first (paths the main process chose, in ~/.claude-ide).
export type Launch = { line: string; env: Record<string, string>; files: { path: string; content: string }[] }

type Injection = { args?: string[]; env?: Record<string, string>; file?: unknown }

export type AgentPreset = {
  id: string // the agent kind its sessions carry
  label: string // badge and button text
  bin: string // the command looked up on PATH
  install: string // shown when it is not installed
  docs: string
  how: Key // how the MCP server goes in, for the settings list
  mcp: ((server: McpServer, configFile: string) => Injection) | null // null: no per-run way, a plain terminal
}

const json = (value: unknown) => JSON.stringify(value)
// JSON that goes on a command line: its spaces written \u0020, the same JSON, because
// PowerShell 5.1 splits an argument holding both a double quote and a space.
const jsonArg = (value: unknown) => json(value).replace(/ /g, '\\u0020')

// A shell word: as it is when it holds nothing the shell would read, else quoted. On Windows
// the terminals run PowerShell 5.1: a single quote inside is doubled, `@` and `,` mean
// something bare, and a double quote reaches the program only written as \".
export function shellWord(word: string, platform: string = process.platform): string {
  if (platform !== 'win32') return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : shellQuote(word)
  return /^[A-Za-z0-9_%+=:./\\-]+$/.test(word) ? word : psQuote(word)
}

// A PowerShell single-quoted string. PowerShell also ends one at the typographic single
// quotes U+2018 to U+201B, so each of those is doubled like the plain one.
export function psQuote(value: string): string {
  return `'${value.replace(/['‘-‛]/g, quote => quote + quote).replace(/"/g, '\\"')}'`
}

// How a launch line starts the CLI. PowerShell would pick an npm shim's .ps1, which the
// default execution policy refuses; the .cmd or .exe beside it runs.
export function commandWord(bin: string, platform: string = process.platform): string {
  return platform === 'win32' ? `& (Get-Command ${bin} -CommandType Application | Select-Object -First 1).Source` : bin
}

// TOML for codex's -c: literal strings need no double quotes; a value holding a single quote
// or a line break falls back to a basic string.
const tomlString = (value: string) => (/['\r\n]/.test(value) ? json(value) : `'${value}'`)

export const PRESETS: AgentPreset[] = [
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    docs: 'https://developers.openai.com/codex/mcp',
    how: 'agents.how.codex',
    // The value of -c is TOML.
    mcp: server => ({
      args: ['-c', `mcp_servers.${MCP_NAME}.command=${tomlString(server.command)}`, '-c', `mcp_servers.${MCP_NAME}.args=[${server.args.map(tomlString).join(',')}]`],
    }),
  },
  {
    id: 'gemini',
    label: 'Gemini',
    bin: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md',
    how: 'agents.how.gemini',
    mcp: (server, configFile) => ({
      // `trust`: Switchboard's own tools run without a confirmation, as they do in Claude Code
      // (the mod's tools); the CLI still asks for its own shell and file tools. open_in_ide's
      // commands are confirmed by the app (src/main/devservers.ts).
      env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: configFile },
      file: { mcpServers: { [MCP_NAME]: { command: server.command, args: server.args, trust: true } } },
    }),
  },
  {
    id: 'qwen',
    label: 'Qwen',
    bin: 'qwen',
    install: 'npm i -g @qwen-code/qwen-code@latest',
    docs: 'https://github.com/QwenLM/qwen-code',
    how: 'agents.how.qwen',
    mcp: (server, configFile) => ({
      args: ['--mcp-config', configFile],
      file: { mcpServers: { [MCP_NAME]: { command: server.command, args: server.args, trust: true } } },
    }),
  },
  {
    id: 'copilot',
    label: 'Copilot',
    bin: 'copilot',
    install: 'npm i -g @github/copilot',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
    how: 'agents.how.copilot',
    mcp: (server, configFile) => ({
      args: ['--additional-mcp-config', `@${configFile}`],
      file: { mcpServers: { [MCP_NAME]: { type: 'local', command: server.command, args: server.args, tools: ['*'] } } },
    }),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    install: 'npm i -g opencode-ai',
    docs: 'https://opencode.ai/docs/mcp-servers/',
    how: 'agents.how.opencode',
    mcp: server => ({
      env: { OPENCODE_CONFIG_CONTENT: json({ mcp: { [MCP_NAME]: { type: 'local', command: [server.command, ...server.args], enabled: true } } }) },
    }),
  },
  {
    id: 'goose',
    label: 'Goose',
    bin: 'goose',
    install: 'brew install block-goose-cli',
    docs: 'https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md',
    how: 'agents.how.goose',
    // Goose splits the extension command at spaces.
    mcp: server => ({ args: ['session', '--with-extension', [server.command, ...server.args].join(' ')] }),
  },
  {
    id: 'amp',
    label: 'Amp',
    bin: 'amp',
    install: 'npm i -g @sourcegraph/amp',
    docs: 'https://ampcode.com/docs/customize/mcp',
    how: 'agents.how.amp',
    mcp: server => ({ args: ['--mcp-config', jsonArg({ [MCP_NAME]: { command: server.command, args: server.args } })] }),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    bin: 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    docs: 'https://cursor.com/docs/cli/reference/parameters',
    how: 'agents.how.undocumented',
    mcp: null,
  },
  {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docs: 'https://docs.x.ai/build/features/mcp-servers',
    how: 'agents.how.undocumented',
    mcp: null,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    bin: 'kimi',
    install: 'npm i -g @moonshot-ai/kimi-code',
    docs: 'https://github.com/MoonshotAI/kimi-code',
    how: 'agents.how.kimi',
    mcp: null,
  },
  {
    id: 'crush',
    label: 'Crush',
    bin: 'crush',
    install: 'brew install charmbracelet/tap/crush',
    docs: 'https://github.com/charmbracelet/crush',
    how: 'agents.how.crush',
    mcp: null,
  },
]

export function presetOf(id: string): AgentPreset | undefined {
  return PRESETS.find(p => p.id === id)
}

// The person's own CLIs, kept in the bridge settings under CUSTOM_AGENTS_KEY.
export type CustomAgent = { id: string; name: string; command: string; mcp: string } // mcp: a template, or 'none'
export const CUSTOM_AGENTS_KEY = 'customAgents'

// Whether the dock offers agent CLIs other than Claude. On unless the setting is exactly false, so
// people who had these buttons before the setting existed keep them.
export const SHOW_OTHER_AGENTS_KEY = 'showOtherAgents'
// true: quitting the app closes its terminals. Unset (the default): the terminal host keeps them
// running through a quit, a restart or an update (src/main/termHost.ts).
export const CLOSE_TERMINALS_KEY = 'closeTerminalsOnQuit'
export const showOtherAgents = (value: unknown): boolean => value !== false

export const PLACEHOLDERS = ['server', 'command', 'args', 'args_json', 'config_file', 'config_json', 'name'] as const

// Every placeholder becomes one or more shell words, already quoted. {server} is the
// whole command as one word, for CLIs that take a command line and split it at spaces.
export function fillTemplate(template: string, server: McpServer, configFile: string, platform: string = process.platform): string {
  const config = jsonArg({ mcpServers: { [MCP_NAME]: { command: server.command, args: server.args } } })
  const word = (value: string) => shellWord(value, platform)
  // Always quoted: these hold spaces or JSON.
  const quoted = (value: string) => (platform === 'win32' ? psQuote(value) : shellQuote(value))
  const values: Record<(typeof PLACEHOLDERS)[number], string> = {
    server: quoted([server.command, ...server.args].join(' ')),
    command: word(server.command),
    args: server.args.map(word).join(' '),
    args_json: quoted(jsonArg(server.args)),
    config_file: word(configFile),
    config_json: quoted(config),
    name: MCP_NAME,
  }
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? values[key as keyof typeof values] : whole))
}

// The JSON a custom entry's {config_file} holds: the mcpServers shape most CLIs read.
export function customConfig(server: McpServer): string {
  return json({ mcpServers: { [MCP_NAME]: { command: server.command, args: server.args } } })
}

export function presetLaunch(preset: AgentPreset, server: McpServer, configFile: string, platform: string = process.platform): Launch {
  const got = preset.mcp?.(server, configFile) ?? {}
  const words = [commandWord(preset.bin, platform), ...(got.args ?? []).map(word => shellWord(word, platform))]
  return {
    line: words.join(' '),
    env: got.env ?? {},
    files: got.file === undefined ? [] : [{ path: configFile, content: `${json(got.file)}\n` }],
  }
}

export function customLaunch(entry: CustomAgent, server: McpServer, configFile: string, platform: string = process.platform): Launch {
  if (entry.mcp === 'none') return { line: entry.command, env: {}, files: [] }
  const filled = fillTemplate(entry.mcp, server, configFile, platform)
  return {
    line: `${entry.command} ${filled}`,
    env: {},
    files: entry.mcp.includes('{config_file}') ? [{ path: configFile, content: `${customConfig(server)}\n` }] : [],
  }
}

export function customAgents(value: unknown): CustomAgent[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (a): a is CustomAgent =>
      !!a && typeof a === 'object' && ['id', 'name', 'command', 'mcp'].every(k => typeof (a as Record<string, unknown>)[k] === 'string'),
  )
}

const CONTROL = /[\u0000-\u001f\u007f]/

// Checks a new entry before it is saved; nothing runs until the person presses its button.
export function validateCustom(
  input: { name: string; command: string; mcp: string },
  existing: readonly CustomAgent[],
): { entry: CustomAgent } | { error: string } {
  const name = input.name.trim()
  const command = input.command.trim()
  const mcp = input.mcp.trim() || 'none'
  if (!name || name.length > 30) return { error: t('agents.err.name') }
  if (CONTROL.test(name)) return { error: t('agents.err.nameLine') }
  if (existing.some(a => a.name === name) || PRESETS.some(p => p.label === name) || name.toLowerCase() === 'claude') {
    return { error: t('agents.err.nameTaken') }
  }
  if (!command || command.length > 300) return { error: t('agents.err.command') }
  if (CONTROL.test(command)) return { error: t('agents.err.commandLine') }
  if (mcp !== 'none') {
    if (mcp.length > 600 || CONTROL.test(mcp)) return { error: t('agents.err.mcpLine') }
    const used = [...mcp.matchAll(/\{([^}]*)\}/g)].map(m => m[1] ?? '')
    const unknown = used.find(key => !(PLACEHOLDERS as readonly string[]).includes(key))
    if (unknown !== undefined) return { error: t('agents.err.unknownPlaceholder', { name: `{${unknown}}`, list: PLACEHOLDERS.map(p => `{${p}}`).join(', ') }) }
    if (used.length === 0) return { error: t('agents.err.needPlaceholder', { example: '{server}' }) }
    if (/['"]\{|\}['"]/.test(mcp)) return { error: t('agents.err.quoted') }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  const taken = new Set(existing.map(a => a.id))
  let id = `custom-${slug || 'cli'}`
  for (let n = 2; taken.has(id); n++) id = `custom-${slug || 'cli'}-${n}`
  return { entry: { id, name, command, mcp } }
}

// The name on a session's badge.
export function agentLabel(kind: string | undefined, customs: readonly CustomAgent[] = []): string {
  if (!kind || kind === 'claude') return 'Claude'
  return presetOf(kind)?.label ?? customs.find(c => c.id === kind)?.name ?? kind
}

// The agents a scheduled prompt can go to: Claude Code, and every installed or added CLI that
// gets the Switchboard server (a session of its own, which the prompt is delivered to). `found`:
// which commands are installed (agents:detect), null while unknown. The one already chosen stays.
export function routineAgents(found: Record<string, unknown> | null, customs: readonly CustomAgent[], chosen?: string): { id: string; label: string }[] {
  const list = [
    { id: 'claude', label: 'Claude Code' },
    ...PRESETS.filter(p => p.mcp !== null && found?.[p.bin]).map(p => ({ id: p.id, label: p.label })),
    ...customs.filter(c => c.mcp !== 'none').map(c => ({ id: c.id, label: c.name })),
  ]
  if (chosen && !list.some(a => a.id === chosen)) list.push({ id: chosen, label: agentLabel(chosen, customs) })
  return list
}

export function isClaude(kind: string | undefined): boolean {
  return !kind || kind === 'claude'
}

// Session id to agent kind, for badges. Empty while every session is Claude Code:
// a badge only says something once another agent is around.
export function agentBadges(sessions: readonly { id: string; agent?: string }[]): Record<string, string> {
  if (sessions.every(s => isClaude(s.agent))) return {}
  return Object.fromEntries(sessions.map(s => [s.id, s.agent || 'claude']))
}

export type AgentTag = { kind: string; label: string }

// Session id to its badge, named; empty while every session is Claude Code (see agentBadges).
export function agentTags(sessions: readonly { id: string; agent?: string }[], customs: readonly CustomAgent[] = []): Record<string, AgentTag> {
  return Object.fromEntries(Object.entries(agentBadges(sessions)).map(([id, kind]) => [id, { kind, label: agentLabel(kind, customs) }]))
}

// The different agents behind one project's sessions, Claude first, for the project list.
export function projectAgents(sessions: readonly { id: string; project: string }[], tags: Record<string, AgentTag>, project: string): AgentTag[] {
  const seen = new Map<string, AgentTag>()
  for (const s of sessions) {
    const tag = s.project === project ? tags[s.id] : undefined
    if (tag && !seen.has(tag.kind)) seen.set(tag.kind, tag)
  }
  return [...seen.values()].sort((a, b) => Number(b.kind === 'claude') - Number(a.kind === 'claude') || a.label.localeCompare(b.label))
}

// The Claude Code the mod needs (README: requirements).
export const CLAUDE_MIN = '2.1.309'

// Whether version a (x.y.z) comes before b.
export function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}
