import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { shellQuote } from '../shared/projects'
import { ccrPaths } from './account'

// The IDE started from an Orca or Claude Code terminal carries the account
// folder (CLAUDE_CONFIG_DIR); remember it in file so a later start from Finder
// uses it too. Capture runs only read it, so checks never change the real file.
export function accountDir(env: Record<string, string | undefined>, file: string): string | undefined {
  const now = env.CLAUDE_CONFIG_DIR
  try {
    if (now) {
      if (!env.CLAUDE_IDE_CAPTURE) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ claudeConfigDir: now }))
      }
      return now
    }
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { claudeConfigDir?: string }).claudeConfigDir
  } catch {
    // fall back to claude's own default
  }
  return undefined
}

// ccr starts claude on a free account and, when that account hits its limit, resumes the same
// conversation on the next one; its arguments are claude's. Plain claude when it is not installed.
// Another tool (claude-code-router) also ships a `ccr` binary, so the name alone proves nothing:
// ccr counts only when its state/current file exists, which the rotator writes on its first run.
export function ccrPath(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string | null {
  if (env.SWITCHBOARD_NO_CCR) return null
  if (!exists(join(ccrPaths(env).root, 'state', 'current'))) return null
  // ccr is a macOS and Linux tool.
  if (process.platform === 'win32') return null
  const dirs = [...(env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin')].filter(Boolean)
  const found = dirs.map(dir => join(dir, 'ccr')).find(exists)
  return found ? shellQuote(found) : null
}

export function claudeLauncher(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string {
  return ccrPath(env, exists) ?? 'claude'
}

// The command line that starts Claude, optionally on a chosen ccr slot. ccr takes no slot argument:
// `ccr use N` pins the slot new runs start on, and the run right after starts there when it is free.
// `use` rewrites the shared state/current, which ccr rewrites on every launch and rotation anyway.
// Without ccr there are no slots, so the slot is ignored.
export function claudeLine(launcher: string, pluginDir: string, slot?: number, slots = 4, hasCcr = launcher !== 'claude'): string {
  const run = `${launcher} --plugin-dir ${pluginDir}`
  if (!hasCcr || slot === undefined || !Number.isInteger(slot) || slot < 1 || slot > slots) return run
  // `;` not `&&`: a failed `use` must still open Claude. Two quick launches can both start on the
  // later slot because `use` writes one shared file before either run reads it.
  return `${launcher} use ${slot}; ${run}`
}
