import { app, type IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CUSTOM_AGENTS_KEY, PRESETS, customAgents, customLaunch, presetLaunch, presetOf, type Launch } from '../shared/agents'
import { terminalEnv } from '../shared/projects'
import { t } from '../shared/i18n'
import type { AgentDetect, Reply, TermInfo } from '../shared/types'
import { detectScript, mcpNode, parseDetect, serverFor } from './agentDetect'
import { openTerminal } from './terminals'
import { nodeRoot } from './appRoot'
import { nodeLauncher } from './runtime'
import { loginShell } from './shell'

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

export function registerAgentTerms(ipcMain: IpcMain, call: (method: string, path: string, body?: unknown) => Promise<Reply>): void {
  pruneFiles()

  ipcMain.handle('agents:detect', (_e, force: boolean) => detect(force === true))

  ipcMain.handle('term:openAgent', async (_e, cwd: string, agentId: string, cols: number, rows: number): Promise<TermInfo | { error: string }> => {
    const preset = presetOf(String(agentId))
    const state = preset ? null : await call('GET', '/state')
    const custom = customAgents((state?.json.settings as Record<string, unknown> | undefined)?.[CUSTOM_AGENTS_KEY]).find(a => a.id === agentId)
    if (!preset && !custom) return { error: t('agents.unknown', { id: String(agentId) }) }
    const found = await detect()
    if (preset && !found.found[preset.bin]) return { error: t('agents.notInstalled', { label: preset.label, install: preset.install }) }
    const needsServer = preset ? preset.mcp !== null : custom!.mcp !== 'none'
    const node = mcpNode(app.isPackaged, process.platform, found.node, nodeLauncher(homedir()))
    if (needsServer && !node) return { error: t('agents.noNode') }
    const id = preset?.id ?? custom!.id
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
  })
}
