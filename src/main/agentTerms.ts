import { app, type IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CUSTOM_AGENTS_KEY, PRESETS, TRUST_FOLDERS_KEY, customAgents, customLaunch, presetLaunch, presetOf, trustFolders, checkedCustom, type Launch } from '../shared/agents'
import { terminalEnv } from '../shared/projects'
import { t } from '../shared/i18n'
import type { AgentDetect, Reply, TermInfo } from '../shared/types'
import { detectScript, mcpNode, parseDetect, serverFor } from './agentDetect'
import { openTerminal } from './terminals'
import { nodeRoot } from './appRoot'
import { nodeLauncher } from './runtime'
import { loginShell } from './shell'
import { trustFolder } from './agentTrust'

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

// Config files a terminal pointed its CLI at; a week later nothing reads them any more.
function pruneFiles(): void {
  try {
    for (const name of readdirSync(DIR)) {
      const file = join(DIR, name)
      if (Date.now() - statSync(file).mtimeMs > STALE_MS) rmSync(file, { force: true })
    }
  } catch {
    // no folder yet
  }
}

function writeFiles(launch: Launch): void {
  if (launch.files.length === 0) return
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  chmodSync(DIR, 0o700)
  for (const f of launch.files) writeFileSync(f.path, f.content, { mode: 0o600 })
}

// `proven`: the bridge proved the app's key (bridgeClient.ts), so its settings are the person's.
type Call = (method: string, path: string, body?: unknown) => Promise<Reply & { proven?: boolean }>


const TRUSTED_AHEAD = ['codex', 'copilot', 'cursor']

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
  const node = mcpNode(app.isPackaged, process.platform, found.node, nodeLauncher(homedir()))
  if (needsServer && !node) return { error: t('agents.noNode') }
  const id = preset?.id ?? custom!.id
  // A trust menu on screen would hold back what the app types in (agentTrust.ts).
  if (preset && TRUSTED_AHEAD.includes(preset.id) && trustFolders(settings?.[TRUST_FOLDERS_KEY])) trustFolder(preset.id, cwd.startsWith('~/') ? homedir() + cwd.slice(1) : cwd, homedir())
  return openTerminal({
    cwd,
    cols,
    rows,
    title: preset ? preset.bin : custom!.name,
    agent: id,
    // npm-installed CLIs run as node.
    bins: [preset ? preset.bin : (custom!.command.trim().split(/\s+/)[0] ?? ''), 'node'].filter(Boolean),
    prepare: key => {
      const server = serverFor(node ?? 'node', join(nodeRoot(), 'mcp', 'server.ts'), id, key, process.env.CLAUDE_IDE_SOCKET)
      const configFile = join(DIR, `${key}-${id}.json`)
      const launch = preset ? presetLaunch(preset, server, configFile) : customLaunch(custom!, server, configFile)
      writeFiles(launch)
      return { env: launch.env, line: launch.line }
    },
  })
}

export function registerAgentTerms(ipcMain: IpcMain, call: Call): void {
  pruneFiles()

  ipcMain.handle('agents:detect', (_e, force: boolean) => detect(force === true))

  ipcMain.handle('term:openAgent', (_e, cwd: string, agentId: string, cols: number, rows: number) => openAgentIn(call, cwd, agentId, cols, rows))
}
