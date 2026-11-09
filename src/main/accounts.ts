import type { Ipc } from './platform'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ACCOUNT_SPECS, accountList, accountOrder, accountSpec, activeOf, limitsOf, nextAccountId, pickAccount, type AccountLimits, type AccountList, type AccountSpec } from '../shared/accounts'
import type { AccountRow, TermInfo } from '../shared/types'
import { commandWord } from '../shared/agents'
import { maskEmail, readAccount } from './account'

// The accounts of each agent CLI (docs/계정-여러-개.md): the list the person keeps, each account's
// home, the env a run on it gets, and when each account's limit lifts.

export type AccountPaths = { root: string; home: string; env: Record<string, string | undefined>; claudeDir?: string }

export const accountPaths = (claudeDir?: string): AccountPaths => ({ root: join(homedir(), '.claude-ide'), home: homedir(), env: process.env, claudeDir })

const listFile = (p: AccountPaths) => join(p.root, 'accounts.json')
const limitsFile = (p: AccountPaths) => join(p.root, 'account-limits.json')

export const homeOf = (p: AccountPaths, agent: string, id: number): string => join(p.root, 'accounts', agent, String(id))

// The CLI's usual home, where account 1 runs and whose history every account shares.
export function defaultBase(p: AccountPaths, agent: string): string {
  switch (agent) {
    case 'claude':
      return p.claudeDir || p.env.CLAUDE_CONFIG_DIR || join(p.home, '.claude')
    case 'codex':
      return p.env.CODEX_HOME || join(p.home, '.codex')
    case 'gemini':
      return p.env.GEMINI_CLI_HOME || p.home
    case 'qwen':
      return p.env.QWEN_HOME || join(p.home, '.qwen')
    case 'copilot':
      return p.env.COPILOT_HOME || join(p.home, '.copilot')
    default:
      return p.home
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export const readAccounts = (p: AccountPaths): AccountList => accountList(readJson(listFile(p)))

// The whole list file: each agent's accounts, and the account each agent's new sessions start on.
type AccountFile = { list: AccountList; active: Record<string, number> }
export function readAccountFile(p: AccountPaths): AccountFile {
  const raw = readJson(listFile(p))
  const list = accountList(raw)
  return { list, active: activeOf(raw, list) }
}
function writeAccountFile(p: AccountPaths, file: AccountFile): void {
  writeJson(listFile(p), { ...file.list, active: file.active })
}

export const readLimits = (p: AccountPaths, now = Date.now()): AccountLimits => limitsOf(readJson(limitsFile(p)), now)

// Notes that the account's limit holds until `until`; a later time already noted stays.
export function markLimit(p: AccountPaths, agent: string, id: number, until: number, now = Date.now()): void {
  const limits = readLimits(p, now)
  const was = limits[agent]?.[String(id)] ?? 0
  if (until <= was) return
  ;(limits[agent] ??= {})[String(id)] = until
  writeJson(limitsFile(p), limits)
}

// The account's home made ready for a run: the default home's history linked in, its settings
// copied when they changed there. A folder the CLI already made in the account's home stays as
// it is (it holds that account's own files); only a missing entry is linked.
export function prepareHome(spec: AccountSpec, base: string, home: string, platform = process.platform): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  for (const rel of spec.shared) {
    const target = join(base, rel)
    const link = join(home, rel)
    try {
      lstatSync(link)
      continue
    } catch {
      // missing: linked below
    }
    try {
      mkdirSync(target, { recursive: true })
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
      // A junction needs no rights a symlink would on Windows.
      symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // that history stays the account's own
    }
  }
  for (const rel of spec.copied) {
    const from = join(base, rel)
    const to = join(home, rel)
    try {
      const source = statSync(from)
      if (existsSync(to) && statSync(to).mtimeMs >= source.mtimeMs) continue
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      copyFileSync(from, to)
    } catch {
      // nothing to copy
    }
  }
}

// Whether the account signed in, by files that only a login writes. Account 1 is the person's
// own login, taken as signed in.
export function signedIn(p: AccountPaths, agent: string, id: number): boolean {
  if (id === 1) return true
  const spec = accountSpec(agent)
  if (!spec) return false
  const home = homeOf(p, agent, id)
  if (agent === 'claude') return readAccount(join(home, '.claude.json')) !== null
  return spec.signedIn.some(rel => existsSync(join(home, rel)))
}

// The masked email of an account, where a file without tokens names it.
export function accountEmail(p: AccountPaths, agent: string, id: number): string {
  const base = id === 1 ? defaultBase(p, agent) : homeOf(p, agent, id)
  if (agent === 'claude') {
    const file = id === 1 && !p.claudeDir && !p.env.CLAUDE_CONFIG_DIR ? join(p.home, '.claude.json') : join(base, '.claude.json')
    return readAccount(file)?.email ?? ''
  }
  if (agent === 'gemini') {
    const active = (readJson(join(base, '.gemini', 'google_accounts.json')) as { active?: unknown } | null)?.active
    return typeof active === 'string' ? maskEmail(active) : ''
  }
  return ''
}

// The runs the app started on an account, by terminal key, for a move to another account at a
// limit (accountRotate.ts). Kept for the app's life: a run the host kept from before is not moved.
export type AccountRun = { agent: string; account: number; cwd: string }
export const accountRuns = new Map<string, AccountRun>()

// The account a new run of the agent goes on, and its env: `asked` when given, else the first free one
// from the account the person picked to use (`active`). No extra accounts, or every one held: the
// CLI's own login, with nothing added.
export function runAccount(p: AccountPaths, agent: string, asked?: number, now = Date.now()): { id: number; env: Record<string, string> } | null {
  const spec = accountSpec(agent)
  const { list, active } = readAccountFile(p)
  const extra = list[agent] ?? []
  if (!spec || extra.length === 0) return null
  const ids = [1, ...extra.map(e => e.id)]
  const id = asked !== undefined && ids.includes(asked) ? asked : pickAccount(accountOrder(ids, active[agent]), n => signedIn(p, agent, n), readLimits(p, now)[agent], now)
  if (id === null) return null
  return { id, env: { ...envOf(p, spec, id), SWITCHBOARD_ACCOUNT: String(id) } }
}

// The env of a run on the account; its home is made ready first.
export function envOf(p: AccountPaths, spec: AccountSpec, id: number): Record<string, string> {
  if (id === 1) return {}
  const base = defaultBase(p, spec.agent)
  const home = homeOf(p, spec.agent, id)
  prepareHome(spec, base, home)
  return spec.env(home, base)
}

// The latest plan usage of each account, from its live sessions: agent → account → percents.
export type AccountUsage = Record<string, Record<number, { five?: number; week?: number }>>

// What the live sessions on each account last reported of their plan (bridge sessions, by the
// terminal key their account run was noted under); the latest report of an account wins.
export function accountUsageOf(sessions: { terminal?: string; usage?: string; last_seen?: number }[], runs: Map<string, AccountRun>): AccountUsage {
  const out: AccountUsage = {}
  const seen: Record<string, number> = {}
  for (const session of sessions) {
    const run = session.terminal ? runs.get(session.terminal) : undefined
    if (!run) continue
    let limits: { kind?: string; percentUsed?: number }[] = []
    try {
      limits = (JSON.parse(session.usage || '{}') as { rateLimits?: typeof limits }).rateLimits ?? []
    } catch {
      continue
    }
    const pct = (kind: string) => limits.find(l => l.kind === kind)?.percentUsed
    const five = pct('five_hour')
    const week = pct('seven_day')
    if (five === undefined && week === undefined) continue
    const at = `${run.agent}:${run.account}`
    if ((seen[at] ?? -1) > (session.last_seen ?? 0)) continue
    seen[at] = session.last_seen ?? 0
    ;(out[run.agent] ??= {})[run.account] = { five, week }
  }
  return out
}

// Each agent with accounts as the settings show them.
export function accountRows(p: AccountPaths, usage: AccountUsage = {}, now = Date.now()): AccountRow[] {
  const { list, active } = readAccountFile(p)
  const limits = readLimits(p, now)
  return ACCOUNT_SPECS.map(spec => ({
    agent: spec.agent,
    active: active[spec.agent] ?? 1,
    accounts: [{ id: 1, name: '' }, ...(list[spec.agent] ?? [])].map(entry => ({
      id: entry.id,
      name: entry.name,
      email: accountEmail(p, spec.agent, entry.id),
      signedIn: signedIn(p, spec.agent, entry.id),
      until: limits[spec.agent]?.[String(entry.id)],
      usage: usage[spec.agent]?.[entry.id],
    })),
  }))
}

// A number for a new account, skipping folders an account removed earlier left behind.
function freshId(p: AccountPaths, list: AccountList, agent: string): number {
  let id = nextAccountId(list, agent)
  while (existsSync(homeOf(p, agent, id))) id += 1
  return id
}

export type OpenLogin = (env: Record<string, string>, line: string, title: string) => TermInfo | { error: string }

export function registerAccounts(ipc: Ipc, paths: () => AccountPaths, openLogin: OpenLogin, usage: () => Promise<AccountUsage> = async () => ({})): void {
  ipc.handle('accounts:list', async () => accountRows(paths(), await usage().catch(() => ({}))))

  const login = (agent: string, id: number) => {
    const spec = accountSpec(agent)
    if (!spec || id < 2) return { error: 'unknown account' }
    const p = paths()
    const [bin, ...args] = spec.login
    return openLogin({ ...envOf(p, spec, id), SWITCHBOARD_ACCOUNT: String(id) }, [commandWord(bin!), ...args].join(' '), `${bin} ${id}`)
  }

  // A new account: its number, its home, and a terminal that signs in there.
  ipc.handle('accounts:add', (_e, agent: string) => {
    if (!accountSpec(agent)) return { error: 'unknown agent' }
    const p = paths()
    const file = readAccountFile(p)
    const id = freshId(p, file.list, agent)
    file.list[agent] = [...(file.list[agent] ?? []), { id, name: '' }]
    writeAccountFile(p, file)
    return login(agent, id)
  })

  ipc.handle('accounts:login', (_e, agent: string, id: number) => login(String(agent), Number(id)))

  ipc.handle('accounts:rename', (_e, agent: string, id: number, name: string) => {
    const p = paths()
    const file = readAccountFile(p)
    const entry = file.list[agent]?.find(e => e.id === Number(id))
    if (!entry) return false
    entry.name = String(name ?? '').trim().slice(0, 60)
    writeAccountFile(p, file)
    return true
  })

  // The account the agent's new sessions start on; running ones keep theirs.
  ipc.handle('accounts:select', (_e, agent: string, id: number) => {
    const p = paths()
    const file = readAccountFile(p)
    const want = Number(id)
    if (!accountSpec(agent) || (want !== 1 && !(file.list[agent] ?? []).some(e => e.id === want))) return false
    if (want === 1) delete file.active[agent]
    else file.active[agent] = want
    writeAccountFile(p, file)
    return true
  })

  // Off the list only: the home stays, with its login, so nothing of it is lost.
  ipc.handle('accounts:remove', (_e, agent: string, id: number) => {
    const p = paths()
    const file = readAccountFile(p)
    const left = (file.list[agent] ?? []).filter(e => e.id !== Number(id))
    if (left.length > 0) file.list[agent] = left
    else delete file.list[agent]
    if (file.active[agent] === Number(id)) delete file.active[agent]
    writeAccountFile(p, file)
    return true
  })
}
