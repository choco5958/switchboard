import type { Ipc } from './platform'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ACCOUNT_SPECS, accountList, accountSpec, limitsOf, nextAccountId, pickAccount, type AccountLimits, type AccountList, type AccountSpec } from '../shared/accounts'
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

// The account a new run of the agent goes on, and its env. `asked`: the one the person picked.
// No extra accounts, or every one held: the CLI's own login, with nothing added.
export function runAccount(p: AccountPaths, agent: string, asked?: number, now = Date.now()): { id: number; env: Record<string, string> } | null {
  const spec = accountSpec(agent)
  const extra = readAccounts(p)[agent] ?? []
  if (!spec || extra.length === 0) return null
  const ids = [1, ...extra.map(e => e.id)]
  const id = asked !== undefined && ids.includes(asked) ? asked : pickAccount(ids, n => signedIn(p, agent, n), readLimits(p, now)[agent], now)
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

// Each agent with accounts as the settings show them.
export function accountRows(p: AccountPaths, now = Date.now()): AccountRow[] {
  const list = readAccounts(p)
  const limits = readLimits(p, now)
  return ACCOUNT_SPECS.map(spec => ({
    agent: spec.agent,
    accounts: [{ id: 1, name: '' }, ...(list[spec.agent] ?? [])].map(entry => ({
      id: entry.id,
      name: entry.name,
      email: accountEmail(p, spec.agent, entry.id),
      signedIn: signedIn(p, spec.agent, entry.id),
      until: limits[spec.agent]?.[String(entry.id)],
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

export function registerAccounts(ipc: Ipc, paths: () => AccountPaths, openLogin: OpenLogin): void {
  ipc.handle('accounts:list', () => accountRows(paths()))

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
    const list = readAccounts(p)
    const id = freshId(p, list, agent)
    list[agent] = [...(list[agent] ?? []), { id, name: '' }]
    writeJson(listFile(p), list)
    return login(agent, id)
  })

  ipc.handle('accounts:login', (_e, agent: string, id: number) => login(String(agent), Number(id)))

  ipc.handle('accounts:rename', (_e, agent: string, id: number, name: string) => {
    const p = paths()
    const list = readAccounts(p)
    const entry = list[agent]?.find(e => e.id === Number(id))
    if (!entry) return false
    entry.name = String(name ?? '').trim().slice(0, 60)
    writeJson(listFile(p), list)
    return true
  })

  // Off the list only: the home stays, with its login, so nothing of it is lost.
  ipc.handle('accounts:remove', (_e, agent: string, id: number) => {
    const p = paths()
    const list = readAccounts(p)
    const left = (list[agent] ?? []).filter(e => e.id !== Number(id))
    if (left.length > 0) list[agent] = left
    else delete list[agent]
    writeJson(listFile(p), list)
    return true
  })
}
