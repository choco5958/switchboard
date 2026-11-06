import { platform, type Ipc } from './platform'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CODEX_APPROVALS_KEY, CUSTOM_AGENTS_KEY, PRESETS, hookAttaches, QWEN_DEFAULTS_ENV, TRUST_FOLDERS_KEY, qwenDefaultsFile, hookCommand, codexHookOverrides, customAgents, customLaunch, presetLaunch, presetOf, trustFolders, checkedCustom, type Launch } from '../shared/agents'
import { terminalEnv } from '../shared/projects'
import { t } from '../shared/i18n'
import type { AgentDetect, Reply, TermInfo } from '../shared/types'
import { cliBins, detectScript, mcpNode, parseDetect, serverFor } from './agentDetect'
import { openTerminal } from './terminals'
import { nodeRoot } from './appRoot'
import { nodeEntry, nodeLauncher } from './runtime'
import { loginShell } from './shell'
import { trustFolder } from './agentTrust'
import { trustCodexHook } from './codexHook'

// Terminals for agent CLIs other than Claude Code: which ones are installed (on the
// login-shell PATH the terminals get) and opening one with the Switchboard MCP server.

const DIR = join(homedir(), '.claude-ide', 'agents')
const STALE_MS = 7 * 24 * 3600_000

let cached: AgentDetect | null = null

function detect(force = false): Promise<AgentDetect> {
  if (cached && !force) return Promise.resolve(cached)
  const bins = ['node', 'claude', ...new Set(PRESETS.map(p => p.bin))]
  const shell = loginShell()
  // Interactive on macOS and Linux, so what .zshrc adds to PATH counts.
  const args = process.platform === 'win32' ? shell.command(detectScript(bins)) : ['-l', '-i', '-c', detectScript(bins)]
  return new Promise(resolve => {
    execFile(shell.file, args, { env: terminalEnv(process.env), timeout: 15_000 }, (_error, stdout) => {
      const found = parseDetect(String(stdout ?? ''))
      const done = (claudeVersion: string | null) => {
        cached = { found, node: found.node ?? null, at: Date.now(), claudeVersion }
        resolve(cached)
      }
      // The mod needs a recent Claude Code: the dock says so when it is older (Dock.tsx).
      if (!found.claude) return done(null)
      execFile(found.claude, ['--version'], { env: terminalEnv(process.env), timeout: 10_000 }, (_e, out) => done(String(out ?? '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null))
    })
  })
}

// The version a CLI says it is (`bin --version`), once per program file as it is now (an update
// changes it); null when it does not say.
const versions = new Map<string, Promise<string | null>>()
function versionOf(path: string): Promise<string | null> {
  let at = 0
  try {
    at = statSync(path).mtimeMs
  } catch {
    // asked anyway
  }
  const key = `${path}:${at}`
  let got = versions.get(key)
  if (!got) {
    got = new Promise(resolve =>
      execFile(path, ['--version'], { env: terminalEnv(process.env), timeout: 10_000 }, (_e, out) => resolve(String(out ?? '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null)),
    )
    versions.set(key, got)
  }
  return got
}

// Config files a terminal pointed its CLI at; a week later nothing reads them any more. A folder
// is a CLI's data folder for a project (AgentPreset.dataFolder), with its history: it stays, and so
// do the plugin folders every Copilot or Cursor run shares.
function pruneFiles(): void {
  try {
    for (const name of readdirSync(DIR)) {
      // A hook socket lives as long as its MCP server, which removes it (mcp/server.ts).
      if (name.endsWith('.sock')) continue
      const file = join(DIR, name)
      const stat = statSync(file)
      if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_MS) rmSync(file, { force: true })
    }
  } catch {
    // no folder yet
  }
}

function writeFiles(launch: Launch): void {
  if (launch.files.length === 0) return
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  chmodSync(DIR, 0o700)
  for (const f of launch.files) {
    if (dirname(f.path) !== DIR) mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 })
    // A file other runs share is written only when it changes: a CLI that reloads its config when
    // the file does (Crush) keeps running as it was.
    if (sameContent(f.path, f.content)) continue
    writeFileSync(f.path, f.content, { mode: 0o600 })
  }
}

function sameContent(path: string, content: string): boolean {
  try {
    return readFileSync(path, 'utf8') === content
  } catch {
    return false
  }
}

// A CLI's data folder for a project: the same for every run there, named by a hash of the folder.
export function dataFolderOf(dir: string, agent: string, cwd: string): string {
  return join(dir, agent, createHash('sha256').update(cwd).digest('hex').slice(0, 16))
}

// The first bytes of a program file (through its symlinks), or null when it cannot be read.
function headOf(path: string | undefined): Uint8Array | null {
  if (!path) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const head = new Uint8Array(4)
      return readSync(fd, head, 0, 4, 0) === 4 ? head : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// `proven`: the bridge proved the app's key (bridgeClient.ts), so its settings are the person's.
type Call = (method: string, path: string, body?: unknown) => Promise<Reply & { proven?: boolean }>

const TRUSTED_AHEAD = ['codex', 'copilot', 'cursor']
// The CLIs whose relay hooks also tell the run's server about the turn (docs/에이전트-대등하게.md),
// and those that take added context with the person's prompt.
const FOLLOWS = ['copilot', 'qwen', 'opencode', 'crush', 'codex']
const PROMPTS = ['qwen', 'codex']

// A terminal running an agent CLI other than Claude Code (a preset or the person's own), with
// the Switchboard MCP server attached to that run. The dock opens these, and so does a
// scheduled prompt whose agent has no session to go to.
export async function openAgentIn(call: Call, cwd: string, agentId: string, cols = 100, rows = 30): Promise<TermInfo | { error: string }> {
  const preset = presetOf(String(agentId))
  // The settings matter for a custom CLI, and for the CLIs whose folder trust the app records.
  const state = !preset || TRUSTED_AHEAD.includes(preset.id) ? await call('GET', '/state') : null
  const settings = state?.proven ? (state.json.settings as Record<string, unknown> | undefined) : undefined
  const custom = checkedCustom(customAgents(settings?.[CUSTOM_AGENTS_KEY]), String(agentId))
  if (!preset && !custom) return { error: t('agents.unknown', { id: String(agentId) }) }
  const found = await detect()
  if (preset && !found.found[preset.bin]) return { error: t('agents.notInstalled', { label: preset.label, install: preset.install }) }
  const needsServer = preset ? preset.mcp !== null : custom!.mcp !== 'none'
  const node = mcpNode(platform().isPackaged, process.platform, found.node, nodeLauncher(homedir()))
  if (needsServer && !node) return { error: t('agents.noNode') }
  const id = preset?.id ?? custom!.id
  const folder = cwd.startsWith('~/') ? homedir() + cwd.slice(1) : cwd
  // A trust menu on screen would hold back what the app types in (agentTrust.ts).
  if (preset && TRUSTED_AHEAD.includes(preset.id) && trustFolders(settings?.[TRUST_FOLDERS_KEY])) trustFolder(preset.id, folder, homedir())
  const cliPath = preset ? found.found[preset.bin] : undefined
  // Codex's permission asks go to the person while away once the relay is on and Codex trusts the
  // hooks (codexHook.ts); if it does not, the terminal opens without them and Codex asks there. Qwen's
  // always do, unless a system defaults file of the machine's would be hidden (qwenDefaultsFile),
  // and OpenCode 2's (its plugin, mcp/opencode/server.ts), Copilot's from 1.0.105 (its plugin folder)
  // and Crush's (the hooks of its project config).
  // On Windows only Copilot's: its hook runs the program with no shell, and scripts/relay-check.ts
  // checks it there (the Test workflow's relay job); the others' hooks are untried on Windows.
  const relays = process.platform !== 'win32' || preset?.id === 'copilot'
  const hook = preset?.permissionHook && node && relays ? { command: node, args: [nodeEntry(nodeRoot(), 'mcp/hook'), preset.id] } : undefined
  const hooked =
    hook && preset?.id === 'codex' && settings?.[CODEX_APPROVALS_KEY] === true && cliPath
      ? await trustCodexHook(
          cliBins(cliPath, headOf(cliPath)).includes('node') && found.node ? [found.node, cliPath] : [cliPath],
          codexHookOverrides(hook),
          hookCommand(hook),
          folder,
          terminalEnv(process.env),
        )
      : preset?.id === 'qwen'
        ? !process.env[QWEN_DEFAULTS_ENV] && !existsSync(qwenDefaultsFile(process.platform))
        : preset?.id === 'opencode' || preset?.id === 'copilot' || preset?.id === 'crush'
  const version = (preset?.versionArgs || hooked) && cliPath ? await versionOf(cliPath) : null
  return openTerminal({
    cwd,
    cols,
    rows,
    title: preset ? preset.bin : custom!.name,
    agent: id,
    // npm-installed CLIs run as node (cliBins).
    bins: preset ? cliBins(preset.bin, headOf(found.found[preset.bin])) : cliBins(custom!.command.trim().split(/\s+/)[0] ?? '', null),
    prepare: key => {
      // Codex's usage comes from the codex the app found (mcp/codexUsage.ts); not on Windows, where
      // what is found is a shim the server cannot start.
      const cli = preset?.id === 'codex' && process.platform !== 'win32' ? cliPath : undefined
      // What this run adds beyond the tools, for the bridge (bridge/server.ts ABILITIES).
      // The hooks of these follow the turn as well; Qwen's and Codex's add to the prompt.
      const attached = !!(hooked && hook && preset && hookAttaches(preset, hook, version))
      const follows = attached && !!preset && FOLLOWS.includes(preset.id)
      const abilities = [
        ...(attached ? ['approvals'] : []),
        ...(follows ? ['turnEnd', 'activity'] : []),
        ...(follows && PROMPTS.includes(preset!.id) ? ['prompt'] : []),
        ...(cli ? ['usage'] : []),
      ]
      const server = serverFor(node ?? 'node', nodeEntry(nodeRoot(), 'mcp/server'), id, key, process.env.CLAUDE_IDE_SOCKET, cli, abilities)
      const configFile = preset?.dataFolder ? join(dataFolderOf(DIR, preset.id, folder), `${preset.id}.json`) : join(DIR, `${key}-${id}.json`)
      const launch = preset ? presetLaunch(preset, server, configFile, process.platform, hooked ? hook : undefined, version) : customLaunch(custom!, server, configFile)
      writeFiles(launch)
      return { env: launch.env, line: launch.line }
    },
  })
}

export function registerAgentTerms(ipcMain: Ipc, call: Call): void {
  pruneFiles()

  ipcMain.handle('agents:detect', (_e, force: boolean) => detect(force === true))

  ipcMain.handle('term:openAgent', (_e, cwd: string, agentId: string, cols: number, rows: number) => openAgentIn(call, cwd, agentId, cols, rows))
}
