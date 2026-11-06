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

// `files`: more files of the run, at the paths given (a plugin folder, for one). `config`, from a
// permission hook: the run's config file whole, in place of what `mcp` wrote there.
type Injection = { args?: string[]; env?: Record<string, string>; file?: unknown; files?: { path: string; value: unknown }[]; config?: unknown }

export type AgentPreset = {
  id: string // the agent kind its sessions carry
  label: string // badge and button text
  bin: string // the command looked up on PATH
  install: string // shown when it is not installed
  docs: string
  how: Key // how the MCP server goes in, for the settings list
  mcp: ((server: McpServer, configFile: string) => Injection) | null // null: no per-run way, a plain terminal
  // The CLI's permission hook for one run (mcp/hook.ts), which sends an ask to the person while
  // they are away; `file` goes to hookFile, and an env var it sets replaces the one `mcp` set
  // (`injected`). Absent: the CLI asks in its terminal only.
  permissionHook?: (hook: McpServer, at: { hookFile: string; injected: Injection; version: string | null }) => Injection
  // The config file sits in a folder the app keeps for the project (the CLI's data folder, which also
  // holds its history), not in one written for the run (src/main/agentTerms.ts).
  dataFolder?: boolean
  // Args that depend on the installed version (`bin --version`, null when unknown).
  versionArgs?: (version: string | null) => string[]
  // 'mod': connected by the Claude Code mod instead of a per-run MCP server (CLAUDE below).
  via?: 'mod'
  // How the CLI goes on with a past conversation of its own, by id (src/main/agentHistory.ts).
  // They come first on the line: Codex's is a subcommand.
  resumeArgs?: (id: string) => string[]
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

// Codex's PermissionRequest hook for one run, as a -c value. Codex runs a hook only once its exact
// definition is trusted (~/.codex/config.toml hooks.state), which the app records when the person
// turned the relay on (src/main/codexHook.ts): so the command never holds anything of one run, and
// the hook finds its run by the terminal's key in its environment. The timeout lets the hook's own
// wait (mcp/permission.ts HOOK_WAIT_MS) end first.
export const HOOK_TIMEOUT_S = 6 * 3600 + 120
// A hook that only tells the server about the turn (mcp/hook.ts EVENT_WAIT_MS is under it).
export const EVENT_TIMEOUT_S = 30
export function hookCommand(hook: McpServer): string {
  return [hook.command, ...hook.args].map(word => shellWord(word, 'linux')).join(' ')
}
// The same command follows the turn as well (docs/에이전트-대등하게.md), each event its own -c value
// so the person's other hooks and hooks.state stay. Codex trusts each hook apart.
export const CODEX_EVENTS = ['PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const
export function codexHookOverrides(hook: McpServer): string[] {
  const command = tomlString(hookCommand(hook))
  return CODEX_EVENTS.map(name => {
    const matcher = name === 'UserPromptSubmit' || name === 'Stop' ? '' : 'matcher="*",'
    return `hooks.${name}=[{${matcher}hooks=[{type="command",command=${command},timeout=${name === 'PermissionRequest' ? HOOK_TIMEOUT_S : EVENT_TIMEOUT_S}}]}]`
  })
}

// The folder a file of the app's is in, with a Windows path's backslashes as well.
const folderOf = (file: string) => file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))

// The Switchboard server's tools (mcp/server.ts mcpTools, kept the same by a test), for a CLI that
// lists the tools it runs without a prompt.
export const SWITCHBOARD_TOOLS = [
  'ask_decision', 'set_task', 'plan_nodes', 'node_worktree', 'list_sessions', 'send_to_session', 'delegate', 'cancel_request',
  'routine_no_update', 'routine_report_failure', 'await_event', 'close_wait', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_navigate', 'browser_console', 'browser_screenshot', 'update_node', 'open_in_ide', 'check_answers',
]

// The server's args without --terminal and its key: for a config file every run shares, whose
// server reads the key from SWITCHBOARD_TERMINAL instead (mcp/server.ts).
function withoutTerminal(args: string[]): string[] {
  const at = args.indexOf('--terminal')
  return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)]
}

// Qwen Code's hook for one run, in a system defaults file (the lowest layer, under the person's own
// settings, and its hooks run with no approval or folder trust: docs/users/features/hooks.md). A
// command hook timeout of 1000 or more is read as milliseconds. Qwen expands $VAR in every string
// of a settings file, so a command holding a $ gets no hook.
export const QWEN_DEFAULTS_ENV = 'QWEN_CODE_SYSTEM_DEFAULTS_PATH'
export function qwenHookSettings(hook: McpServer): unknown | null {
  const command = hookCommand(hook)
  if (command.includes('$')) return null
  // The same command follows the turn too (docs/에이전트-대등하게.md): the person's prompt, each tool
  // and the turn's end, each with a short timeout (milliseconds as well).
  const follow = (name: string) => [name, [{ matcher: '*', hooks: [{ type: 'command', command, name: 'switchboard', timeout: EVENT_TIMEOUT_S * 1000 }] }]]
  return {
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command, name: 'switchboard', timeout: HOOK_TIMEOUT_S * 1000 }] }],
      ...Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(follow)),
    },
  }
}

// Where Qwen Code reads its system defaults when the env var does not say. A run that names its own
// file would hide this one, so a machine that has one (or an env var already set) gets no hook.
export function qwenDefaultsFile(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/QwenCode/system-defaults.json'
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\system-defaults.json'
  return '/etc/qwen-code/system-defaults.json'
}

// The first Copilot CLI its relay was tested with.
export const COPILOT_HOOK_VERSION = '1.0.105'

export const PRESETS: AgentPreset[] = [
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    docs: 'https://developers.openai.com/codex/mcp',
    how: 'agents.how.codex',
    resumeArgs: id => ['resume', id],
    // The value of -c is TOML.
    mcp: server => ({
      args: ['-c', `mcp_servers.${MCP_NAME}.command=${tomlString(server.command)}`, '-c', `mcp_servers.${MCP_NAME}.args=[${server.args.map(tomlString).join(',')}]`],
    }),
    permissionHook: hook => ({ args: codexHookOverrides(hook).flatMap(value => ['-c', value]) }),
  },
  {
    id: 'gemini',
    label: 'Gemini',
    bin: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md',
    how: 'agents.how.gemini',
    resumeArgs: id => ['--resume', id],
    mcp: (server, configFile) => ({
      // `trust`: Switchboard's own tools run without a confirmation, as they do in Claude Code
      // (the mod's tools); the CLI still asks for its own shell and file tools. open_in_ide's
      // commands are confirmed by the app (src/main/devservers.ts).
      env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: configFile },
      file: { mcpServers: { [MCP_NAME]: { command: server.command, args: server.args, trust: true } } },
    }),
    // Gemini 0.67 reads a system defaults file only in folders root owns, so this reaches older ones
    // only; with GEMINI_EXTENSION_KEY on, the server and hooks go in an extension (geminiExtension).
  },
  {
    id: 'qwen',
    label: 'Qwen',
    bin: 'qwen',
    install: 'npm i -g @qwen-code/qwen-code@latest',
    docs: 'https://github.com/QwenLM/qwen-code',
    how: 'agents.how.qwen',
    resumeArgs: id => ['--resume', id],
    mcp: (server, configFile) => ({
      args: ['--mcp-config', configFile],
      file: { mcpServers: { [MCP_NAME]: { command: server.command, args: server.args, trust: true } } },
    }),
    permissionHook: (hook, { hookFile }) => {
      const settings = qwenHookSettings(hook)
      return settings ? { env: { [QWEN_DEFAULTS_ENV]: hookFile }, file: settings } : {}
    },
  },
  {
    id: 'copilot',
    label: 'Copilot',
    bin: 'copilot',
    install: 'npm i -g @github/copilot',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
    how: 'agents.how.copilot',
    resumeArgs: id => ['--resume', id],
    mcp: (server, configFile) => ({
      args: ['--additional-mcp-config', `@${configFile}`],
      file: { mcpServers: { [MCP_NAME]: { type: 'local', command: server.command, args: server.args, tools: ['*'] } } },
    }),
    // A plugin of the run (--plugin-dir) whose permissionRequest hook sends the asks away. Its folder
    // is one for every Copilot run: the command holds nothing of a run, and the hook finds its run by
    // SWITCHBOARD_TERMINAL, which Copilot hands it. Copilot needs plugin.json, and reads hooks.json
    // beside it (1.0.105, tested; the plugin layout changed in 1.0.80, so older ones get no hook).
    // scripts/relay-check.ts runs this with the real Copilot on macOS, Windows and Linux.
    permissionHook: (hook, { hookFile, version }) => {
      if (!version || olderThan(version, COPILOT_HOOK_VERSION)) return {}
      const dir = `${folderOf(hookFile)}/copilot-plugin`
      return {
        args: ['--plugin-dir', dir],
        files: [
          { path: `${dir}/plugin.json`, value: { name: 'switchboard-approvals', version: '1.0.0', description: 'Switchboard: permission asks while you are away' } },
          // exec and args: Copilot runs the program itself, with no shell to quote for (Windows too).
          {
            path: `${dir}/hooks.json`,
            value: {
              version: 1,
              hooks: {
                permissionRequest: [{ type: 'command', exec: hook.command, args: hook.args, timeoutSec: HOOK_TIMEOUT_S }],
                // The turn, followed as the mod follows Claude Code's (docs/에이전트-대등하게.md).
                ...Object.fromEntries(
                  // Copilot names the event in its input only for permissionRequest, so the name goes as an argument.
                  ['userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop'].map(name => [name, [{ type: 'command', exec: hook.command, args: [...hook.args, name], timeoutSec: EVENT_TIMEOUT_S }]]),
                ),
              },
            },
          },
        ],
      }
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    install: 'npm i -g opencode-ai',
    docs: 'https://opencode.ai/docs/mcp-servers/',
    how: 'agents.how.opencode',
    // OpenCode 2 runs every TUI on one background service, started by the first: a second terminal's
    // env never reached it, so it had no server of its own. --standalone gives the run a private
    // server with this env (OpenCode 2.2.5, tested); OpenCode 1 has no such flag and no service.
    versionArgs: version => (version && !olderThan(version, '2.0.0') ? ['--standalone'] : []),
    mcp: server => ({
      env: { OPENCODE_CONFIG_CONTENT: json({ mcp: { [MCP_NAME]: { type: 'local', command: [server.command, ...server.args], enabled: true } } }) },
    }),
    // OpenCode 2 takes the plugins of every config it reads, so this one adds to the person's
    // (packages/core/src/plugin/supervisor.ts). The plugin (mcp/opencode) sits beside the hook command.
    permissionHook: (hook, { injected, version }) => {
      const content = injected.env?.OPENCODE_CONFIG_CONTENT
      const plugin = hook.args[0]?.replace(/hook\.m?[jt]s$/, 'opencode')
      if (!content || !plugin || plugin === hook.args[0] || !version || olderThan(version, '2.0.0')) return {}
      return { env: { OPENCODE_CONFIG_CONTENT: json({ ...(JSON.parse(content) as object), plugins: [plugin] }) } }
    },
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
    how: 'agents.how.cursor',
    // A plugin (--plugin-dir) holding the server: Cursor starts a plugin's MCP servers with no
    // approval and without --approve-mcps, which would also approve a cloned repo's own servers
    // (cursor-agent 2026.11.05, tested). Cursor names the server after the plugin's folder, so every
    // run shares one folder and a tool the person allowlists stays allowed. Cursor does not hand its
    // env to the server: the terminal's key goes in through Cursor's ${env:} in the server's env.
    mcp: (server, configFile) => {
      const dir = `${folderOf(configFile)}/cursor-plugin`
      const mcpServer = { command: server.command, args: withoutTerminal(server.args), env: { SWITCHBOARD_TERMINAL: '${env:SWITCHBOARD_TERMINAL}' } }
      return {
        args: ['--plugin-dir', dir],
        files: [{ path: `${dir}/.cursor-plugin/plugin.json`, value: { name: MCP_NAME, version: '1.0.0', description: 'Switchboard', mcpServers: { [MCP_NAME]: mcpServer } } }],
      }
    },
  },
  {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docs: 'https://docs.x.ai/build/features/mcp-servers',
    // Grok 1.0.77 has no --plugin-dir (its docs name one), and its GROK_CONFIG overlay ignores
    // mcp_servers and plugins.paths (grok inspect, tested). --agent would carry mcpServers, but it
    // replaces Grok's own agent and its prompt.
    how: 'agents.how.grok',
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
    dataFolder: true,
    // -D names Crush's data folder, whose crush.json Crush merges over the person's own config (an
    // array adds to theirs, so allowed_tools does not replace their list); the login stays in Crush's
    // global data (internal/config/load.go). The history of these runs stays in that folder, one per
    // project. Every run in the project writes the same file, so two Crush terminals there do not
    // change each other's server: its key comes from SWITCHBOARD_TERMINAL, which Crush passes on to
    // the server. Crush runs these values through its shell expansion (internal/shell/expand.go); one
    // holding a character that expansion reads (a Windows path's backslash among them) gets a plain
    // terminal.
    mcp: (server, configFile) => {
      const args = withoutTerminal(server.args)
      if ([server.command, ...args, configFile].some(value => /[$`\\'"]/.test(value))) return {}
      return {
        args: ['-D', configFile.slice(0, configFile.lastIndexOf('/'))],
        file: {
          mcp: { [MCP_NAME]: { type: 'stdio', command: server.command, args } },
          permissions: { allowed_tools: SWITCHBOARD_TOOLS.map(name => `mcp_${MCP_NAME}_${name}`) },
        },
      }
    },
    // Crush's hooks go in the same file (docs/hooks, 0.99): its shell runs the command, so it is a
    // shell line. The command holds nothing of a run, as the file is the project's: the hook finds
    // its run by SWITCHBOARD_TERMINAL, which Crush hands its hooks. PreToolUse asks while away
    // (mcp/permission.ts), so it may wait as long as the other CLIs' permission hooks.
    permissionHook: (hook, { injected }) => {
      if (injected.file === undefined) return {}
      const command = hookCommand(hook)
      const follow = (timeout: number) => [{ name: 'switchboard', command, timeout }]
      const hooks = {
        PreToolUse: follow(HOOK_TIMEOUT_S),
        ...Object.fromEntries(['PostToolUse', 'PostToolUseFailure', 'TurnStart', 'TurnEnd', 'Interrupt', 'StopFailure'].map(name => [name, follow(EVENT_TIMEOUT_S)])),
      }
      return { config: { ...(injected.file as object), hooks } }
    },
  },
]

export function presetOf(id: string): AgentPreset | undefined {
  return PRESETS.find(p => p.id === id)
}

// Claude Code, as the other agents are described: listed, looked for and named the same way. It is
// not in PRESETS, whose CLIs open with a per-run MCP server (src/main/agentTerms.ts): Claude Code
// opens with the mod (src/main/terminals.ts claudeLine), which does all the hooks do and more.
export const CLAUDE: AgentPreset = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  install: 'npm i -g @anthropic-ai/claude-code',
  docs: 'https://code.claude.com/docs',
  how: 'agents.how.claude',
  mcp: null,
  via: 'mod',
  resumeArgs: id => ['--resume', id],
}

// Every agent the app knows, Claude Code first: for lists, detection and names.
export const AGENTS: AgentPreset[] = [CLAUDE, ...PRESETS]
export const agentOf = (id: string): AgentPreset | undefined => AGENTS.find(p => p.id === id)

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

// Settings: record folder trust before Codex, Copilot or Cursor opens there (src/main/agentTrust.ts).
// Off unless turned on: a trusted folder's own agent config runs (its MCP servers, its hooks), and
// a folder just cloned is not the person's to vouch for yet.
export const TRUST_FOLDERS_KEY = 'trustFolders'

// Settings: send Codex's permission asks to the person while they are away (mcp/hook.ts). Off unless
// turned on: it records Switchboard's hook as trusted in the person's Codex config.
export const CODEX_APPROVALS_KEY = 'codexApprovals'
export const trustFolders = (value: unknown): boolean => value === true

// Settings: connect Gemini CLI through an extension of Switchboard's (src/main/geminiExtension.ts).
// Off unless turned on: it links the extension in the person's Gemini folder (~/.gemini/extensions).
export const GEMINI_EXTENSION_KEY = 'geminiExtension'

// Switchboard's Gemini extension, in a folder of the app's that `gemini extensions link` points at.
// Every Gemini run starts its server, so nothing of one run is in it: the server finds its run by
// SWITCHBOARD_TERMINAL and does nothing without one (--app-only), and the run's abilities come in
// SWITCHBOARD_ABILITIES. Gemini hands both on, as it does the rest of the env unless the person
// turned on its redaction. The hooks follow the turn (Gemini 0.67, docs/hooks: a hook cannot allow
// a tool past Gemini's prompt, so no ask goes away). A timeout is in milliseconds.
export const GEMINI_EXTENSION = 'switchboard'
// Set on a run the app opened through the extension: with the setting off, the link may still be
// there, and the extension's server and hooks then stay quiet in the app's terminals too.
export const EXTENSION_RUN_ENV = 'SWITCHBOARD_EXTENSION'
export function geminiExtension(server: McpServer, hook: McpServer | undefined, folder: string): { path: string; value: unknown }[] {
  const at = server.args.indexOf('--abilities')
  const args = [...withoutTerminal(at < 0 ? server.args : [...server.args.slice(0, at), ...server.args.slice(at + 2)]), '--app-only']
  const manifest = { name: GEMINI_EXTENSION, version: '1.0.0', description: 'Switchboard', mcpServers: { [MCP_NAME]: { command: server.command, args } } }
  const command = hook ? hookCommand(hook) : ''
  const follow = (name: string) => [name, [{ matcher: '*', hooks: [{ type: 'command', name: 'switchboard', command, timeout: EVENT_TIMEOUT_S * 1000 }] }]]
  return [
    { path: `${folder}/gemini-extension.json`, value: manifest },
    // Gemini fills ${…} in this file: a command holding one gets no hooks.
    { path: `${folder}/hooks/hooks.json`, value: { hooks: command && !command.includes('${') ? Object.fromEntries(['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent'].map(follow)) : {} } },
  ]
}

// A policy for one run (--policy): Switchboard's tools run without a confirmation, as they do in
// Claude Code; Gemini still asks for its own. An extension's server cannot be given `trust`.
export function geminiLaunch(policyFile: string, abilities: readonly string[], platform: string = process.platform, resume?: string): Launch {
  return {
    line: [commandWord('gemini', platform), ...(resume ? ['--resume', resume] : []), '--policy', shellWord(policyFile, platform)].join(' '),
    env: { SWITCHBOARD_ABILITIES: abilities.join(','), [EXTENSION_RUN_ENV]: '1' },
    files: [{ path: policyFile, content: `[[rule]]\ntoolName = "*"\nmcpName = "${MCP_NAME}"\ndecision = "allow"\npriority = 100\n` }],
  }
}

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

// `hook`: the permission hook's command, when this run sends asks away (src/main/agentTerms.ts).
// The file a permission hook's settings go to, beside the run's config file.
export const hookFileOf = (configFile: string) => configFile.replace(/(\.json)?$/, '-hook.json')

// Whether a run of this preset gets its relay hook at all (the version, a command the CLI's config
// cannot hold): what the run's server says it can do depends on it (src/main/agentTerms.ts).
export function hookAttaches(preset: AgentPreset, hook: McpServer, version: string | null): boolean {
  const injected = preset.mcp?.({ command: hook.command, args: [] }, '/sb/agents/run.json') ?? {}
  const got = preset.permissionHook?.(hook, { hookFile: '/sb/agents/run-hook.json', injected, version }) ?? {}
  return (got.args?.length ?? 0) > 0 || got.env !== undefined || got.file !== undefined || got.config !== undefined || (got.files?.length ?? 0) > 0
}

// `resume`: a past conversation's id, checked by the caller (resumableId).
export function presetLaunch(preset: AgentPreset, server: McpServer, configFile: string, platform: string = process.platform, hook?: McpServer, version: string | null = null, resume?: string): Launch {
  const got = preset.mcp?.(server, configFile) ?? {}
  const pinned = [...(resume && preset.resumeArgs ? preset.resumeArgs(resume) : []), ...(preset.versionArgs?.(version) ?? [])]
  const hookFile = hookFileOf(configFile)
  const hooked = hook && preset.permissionHook ? preset.permissionHook(hook, { hookFile, injected: got, version }) : {}
  const words = [commandWord(preset.bin, platform), ...[...pinned, ...(got.args ?? []), ...(hooked.args ?? [])].map(word => shellWord(word, platform))]
  return {
    line: words.join(' '),
    env: { ...got.env, ...hooked.env },
    files: [
      ...((hooked.config ?? got.file) === undefined ? [] : [{ path: configFile, content: `${json(hooked.config ?? got.file)}\n` }]),
      ...(hooked.file === undefined ? [] : [{ path: hookFile, content: `${json(hooked.file)}\n` }]),
      ...[...(got.files ?? []), ...(hooked.files ?? [])].map(f => ({ path: f.path, content: `${json(f.value)}\n` })),
    ],
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

// A custom CLI as saved, checked again as when it was saved before it runs (src/main/agentTerms.ts):
// the line comes from the bridge's settings, and only an entry that passes runs.
export function checkedCustom(listed: readonly CustomAgent[], id: string): CustomAgent | undefined {
  const entry = listed.find(a => a.id === id)
  if (!entry || !/^custom-[a-z0-9-]+$/.test(entry.id)) return undefined
  const checked = validateCustom(entry, listed.filter(a => a !== entry))
  return 'entry' in checked ? { ...checked.entry, id: entry.id } : undefined
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
    { id: CLAUDE.id, label: CLAUDE.label },
    ...PRESETS.filter(p => p.mcp !== null && found?.[p.bin]).map(p => ({ id: p.id, label: p.label })),
    ...customs.filter(c => c.mcp !== 'none').map(c => ({ id: c.id, label: c.name })),
  ]
  if (chosen && !list.some(a => a.id === chosen)) list.push({ id: chosen, label: agentLabel(chosen, customs) })
  return list
}

export function isClaude(kind: string | undefined): boolean {
  return !kind || kind === 'claude'
}

// A Claude Code session id as `claude --resume` takes it (a UUID). The app types it into a
// shell line as is, so an id with any other character is never resumed.
export function resumableId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/.test(id)
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
