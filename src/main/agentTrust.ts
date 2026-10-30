// A CLI opened in a folder for the first time asks whether to trust it. The app types answers
// and scheduled prompts into Codex, Copilot and Cursor terminals, and a trust menu on screen
// would hold them back until someone answers it, so the app records the trust before it opens
// one, for the folders the person opened it in. The same as answering yes in the CLI's own
// menu; the CLI's approval and sandbox settings stay as they are. Only when the person turned
// it on (agents.ts trustFolders), and never for a folder that brings agent config of its own
// (agentConfigIn): trusting it is what lets that config run, and that stays the person's call.
// Claude Code is left alone: answers reach it through the mod, not its input, and it rewrites
// its own .claude.json all the time, so a write from here could lose one of its changes.
// The approach follows Orca's agent-trust-presets.ts (MIT, github.com/stablyai/orca).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Each CLI compares the real path of the folder, so a symlink (macOS /tmp) is followed.
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder)
  } catch {
    return folder
  }
}

// Written beside and renamed over, so the CLI never reads a half-written file; the mode stays.
function replaceFile(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true })
  const keep = existsSync(file) ? statSync(file).mode & 0o777 : mode
  const temp = `${file}.switchboard-${process.pid}`
  writeFileSync(temp, content, { mode: keep })
  renameSync(temp, file)
}

// A basic string: a control character (a folder name may hold one) is written as \uXXXX.
const tomlString = (text: string) =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`

// Codex: [projects."<folder>"] trust_level = "trusted" in config.toml. A folder the file names
// already, trusted or not, is the person's choice and is left as it is.
export function codexTrustText(existing: string, folder: string): string | null {
  const header = `[projects.${tomlString(folder)}]`
  if (existing.split(/\r?\n/).some(line => line.trim() === header)) return null
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const gap = existing === '' || existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol
  return `${existing}${gap}${header}${eol}trust_level = "trusted"${eol}`
}

// Copilot: trustedFolders in ~/.copilot/config.json. A file it cannot read stays untouched.
export function copilotTrustText(existing: string | null, folder: string): string | null {
  let config: Record<string, unknown> = {}
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      config = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const trusted = Array.isArray(config.trustedFolders) ? config.trustedFolders.filter((f): f is string => typeof f === 'string') : []
  if (trusted.includes(folder)) return null
  return `${JSON.stringify({ ...config, trustedFolders: [...trusted, folder] }, null, 2)}\n`
}

// Cursor: a .workspace-trusted file in ~/.cursor/projects/<folder as a slug>/.
export function cursorTrustFile(home: string, folder: string): string | null {
  const slug = folder.replace(/^[\\/]+/, '').replace(/[\\/:*?"<>|]+/g, '-')
  return slug ? join(home, '.cursor', 'projects', slug, '.workspace-trusted') : null
}

// Config an agent CLI reads from the folder itself once it trusts it: MCP servers, hooks,
// instructions. The first one found, or null.
const AGENT_CONFIG = ['.codex', '.cursor', '.mcp.json', '.vscode/mcp.json']
export function agentConfigIn(folder: string): string | null {
  for (const name of AGENT_CONFIG) if (existsSync(join(folder, name))) return name
  try {
    const copilot = readdirSync(join(folder, '.github')).find(name => name.toLowerCase().startsWith('copilot'))
    if (copilot) return `.github/${copilot}`
  } catch {
    // No .github folder.
  }
  return null
}

// Records the trust for `agent` (an agents.ts id) in `folder`; quietly does nothing for the
// other CLIs, a folder with agent config of its own, or when the CLI's file cannot be read.
// Never throws: opening the terminal matters more.
export function trustFolder(agent: string, folder: string, home: string, env: Record<string, string | undefined> = process.env): void {
  try {
    const path = realFolder(folder)
    const config = agentConfigIn(path)
    if (config) {
      console.error(`not recording folder trust for ${agent} in ${path}: it has ${config}`)
      return
    }
    if (agent === 'codex') {
      const file = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
      const next = codexTrustText(existsSync(file) ? readFileSync(file, 'utf8') : '', path)
      if (next !== null) replaceFile(file, next)
    } else if (agent === 'copilot') {
      const file = join(home, '.copilot', 'config.json')
      const next = copilotTrustText(existsSync(file) ? readFileSync(file, 'utf8') : null, path)
      if (next !== null) replaceFile(file, next)
    } else if (agent === 'cursor') {
      const file = cursorTrustFile(home, path)
      if (file && !existsSync(file)) replaceFile(file, `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: path }, null, 2)}\n`)
    }
  } catch (error) {
    console.error(`could not record folder trust for ${agent}:`, error)
  }
}
