import type { IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, CcrSlot } from '../shared/types'

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

// ccr (the account rotator) keeps several Claude logins: slot 1 is ~/.claude.json, slot N is
// <root>/N/.claude.json, and <root>/state holds current (the slot new sessions start on),
// until-N (epoch seconds the slot's limit lifts) and usage-N.json (what ccr last measured).
// Only those files are read, never the ones holding tokens.
export type CcrPaths = { root: string; home: string; count: number }

export function ccrPaths(env: Record<string, string | undefined> = process.env): CcrPaths {
  return { root: env.CCR_ROOT || join(homedir(), '.claude-acct'), home: homedir(), count: Number(env.CCR_ACCOUNTS) || 4 }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

type UsageWindow = { utilization?: unknown; resets_at?: unknown }

// A measurement from before the window reset says nothing about now, so it is left out. ccr measures
// only when asked (ccr status, or when it picks a slot), so the files are often days old.
function percentOf(window: UsageWindow | null | undefined, measuredAt: number | undefined, span: number, now: number): number | undefined {
  if (typeof window?.utilization !== 'number') return undefined
  const resets = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN
  if (Number.isFinite(resets) ? resets <= now : measuredAt === undefined || measuredAt * 1000 + span <= now) return undefined
  return Math.round(window.utilization)
}

// ccr stores the refresh token's expiry in epoch milliseconds (checked against real usage files).
// A seconds-sized value would read as 1970, so anything that small is dropped instead of shown as expired.
export function refreshExpiry(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 1e11 ? value : undefined
}

export { refreshDaysLeft } from '../shared/ccr'

// A year token exists when its keychain item does. The check uses only the exit code of a lookup that
// does not ask for the secret (no -w), and its output is dropped, so the token value is never read.
export function hasYearToken(slot: number, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const service = `${env.CCR_TOKEN_SERVICE || 'ccr-oauth'}-${slot}`
  return new Promise(resolve => {
    const child = execFile('security', ['find-generic-password', '-s', service, '-a', 'ccr'], { timeout: 5_000 }, error => resolve(!error))
    child.stdout?.resume()
  })
}

const FIVE_HOURS = 5 * 3600_000
const WEEK = 7 * 86400_000

export function readCcrSlot(paths: CcrPaths, slot: number, now = Date.now()): CcrSlot {
  const config = slot === 1 ? join(paths.home, '.claude.json') : join(paths.root, String(slot), '.claude.json')
  const account = readAccount(config)
  const untilRaw = readText(join(paths.root, 'state', `until-${slot}`))
  const until = /^\d+$/.test(untilRaw) ? Number(untilRaw) : 0
  let usage: {
    at?: unknown
    ok?: unknown
    data_at?: unknown
    err?: unknown
    data?: { five_hour?: UsageWindow; seven_day?: UsageWindow }
    cred?: { refreshTokenExpiresAt?: unknown }
  } = {}
  try {
    usage = JSON.parse(readFileSync(join(paths.root, 'state', `usage-${slot}.json`), 'utf8'))
  } catch {
    // a slot ccr never measured
  }
  const data = usage.data ?? {}
  // A failed measurement keeps the last good data, and data_at says when that was.
  const measuredAt = typeof usage.data_at === 'number' ? usage.data_at : usage.ok === true && typeof usage.at === 'number' ? usage.at : undefined
  return {
    slot,
    email: account?.email ?? '',
    plan: account?.plan ?? '',
    until,
    fiveHour: percentOf(data.five_hour, measuredAt, FIVE_HOURS, now),
    week: percentOf(data.seven_day, measuredAt, WEEK, now),
    weekResetsAt: typeof data.seven_day?.resets_at === 'string' ? data.seven_day.resets_at : undefined,
    measuredAt,
    refreshExpiresAt: refreshExpiry(usage.cred?.refreshTokenExpiresAt),
    measureError: usage.ok === false && typeof usage.err === 'string' ? usage.err.slice(0, 160) : undefined,
  }
}

export function readCcr(paths = ccrPaths(), now = Date.now()): AccountInfo['ccr'] {
  const current = readText(join(paths.root, 'state', 'current'))
  if (!/^\d+$/.test(current)) return undefined
  const slots = Array.from({ length: paths.count }, (_, i) => readCcrSlot(paths, i + 1, now))
  return { current: Number(current), slots }
}

// With ccr, the top bar shows the slot new sessions start on; without it, the account the app runs under.
export function readAccountInfo(paths = ccrPaths(), now = Date.now()): AccountInfo | null {
  const ccr = readCcr(paths, now)
  if (!ccr) return readAccount()
  const current = ccr.slots.find(s => s.slot === ccr.current)
  return { email: current?.email ?? '', plan: current?.plan ?? '', ccr }
}

// ccr status measures every signed-in slot (it holds the tokens; this app never does) and rewrites
// usage-N.json. A login shell, since an app started from Finder has no PATH to claude or ccr.
function measureCcr(ccr: string): Promise<void> {
  return new Promise(resolve => {
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-c', `${ccr} status -s`], { timeout: 60_000 }, () => resolve())
  })
}

// The files give the slots; the keychain says which of them run on a year token.
// The keychain lookup spawns one process per slot and the answer rarely changes, so it is kept for
// five minutes; an explicit measure request bypasses the cache.
const TOKEN_CACHE_MS = 5 * 60_000
let tokenCache: { at: number; tokens: boolean[] } | null = null

export async function readAccountInfoWithTokens(fresh = false): Promise<AccountInfo | null> {
  const info = readAccountInfo()
  if (!info?.ccr) return info
  const count = info.ccr.slots.length
  if (fresh || !tokenCache || Date.now() - tokenCache.at > TOKEN_CACHE_MS || tokenCache.tokens.length !== count) {
    tokenCache = { at: Date.now(), tokens: await Promise.all(info.ccr.slots.map(slot => hasYearToken(slot.slot))) }
  }
  const tokens = tokenCache.tokens
  info.ccr.slots.forEach((slot, i) => (slot.token = tokens[i]))
  return info
}

export function registerAccount(ipc: IpcMain, ccr: () => string | null): void {
  ipc.handle('account:info', () => readAccountInfoWithTokens())
  let measuring: Promise<void> | null = null
  ipc.handle('account:measure', async () => {
    const path = ccr()
    if (path) await (measuring ??= measureCcr(path).finally(() => (measuring = null)))
    return readAccountInfoWithTokens(true)
  })
}
