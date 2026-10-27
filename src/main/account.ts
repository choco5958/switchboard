import type { IpcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo } from '../shared/types'

// The signed-in Claude account for the top bar. Display only: the email never leaves this machine.

export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return ''
  return `${email.slice(0, Math.min(2, at))}****${email.slice(at)}`
}

// "default_claude_max_20x" → "Claude Max 20x", "claude_pro" → "Claude Pro".
export function planLabel(tier: string): string {
  const words = tier
    .replace(/^default_/, '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(word => (/^\d+x$/i.test(word) ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1)))
  return words.join(' ')
}

type OauthAccount = {
  emailAddress?: string
  userRateLimitTier?: string | null
  organizationRateLimitTier?: string | null
  organizationType?: string | null
  seatTier?: string | null
}

export function accountOf(config: { oauthAccount?: OauthAccount } | null): AccountInfo | null {
  const account = config?.oauthAccount
  if (!account?.emailAddress) return null
  const tier = account.userRateLimitTier || account.organizationRateLimitTier || account.organizationType || account.seatTier || ''
  return { email: maskEmail(account.emailAddress), plan: tier ? planLabel(tier) : '' }
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR
  if (dir && existsSync(join(dir, '.claude.json'))) return join(dir, '.claude.json')
  return join(homedir(), '.claude.json')
}

export function readAccount(path = configPath()): AccountInfo | null {
  try {
    return accountOf(JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: OauthAccount })
  } catch {
    return null
  }
}

export function registerAccount(ipc: IpcMain): void {
  ipc.handle('account:info', () => readAccount())
}
