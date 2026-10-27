import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
