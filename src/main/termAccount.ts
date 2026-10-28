import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { shellQuote } from '../shared/projects'

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
export function ccrPath(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string | null {
  if (env.SWITCHBOARD_NO_CCR) return null
  const dirs = [...(env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin')].filter(Boolean)
  const found = dirs.map(dir => join(dir, 'ccr')).find(exists)
  return found ? shellQuote(found) : null
}

export function claudeLauncher(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync): string {
  return ccrPath(env, exists) ?? 'claude'
}
