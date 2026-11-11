import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountList, accountOrder, accountSpec, activeOf, limitsOf, nextAccountId, pickAccount } from '../shared/accounts'
import { accountRows, accountUsageOf, claudeStateText, defaultBase, homeOf, markLimit, prepareHome, readLimits, runAccount, type AccountPaths } from './accounts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function paths(env: Record<string, string> = {}): AccountPaths {
  const home = mkdtempSync(join(tmpdir(), 'sb-acct-'))
  dirs.push(home)
  return { root: join(home, '.claude-ide'), home, env }
}

function keep(p: AccountPaths, value: unknown): void {
  mkdirSync(p.root, { recursive: true })
  writeFileSync(join(p.root, 'accounts.json'), JSON.stringify(value))
}

describe('the account list', () => {
  it('keeps known agents, numbers from 2, each once, in order', () => {
    expect(accountList({ codex: [{ id: 3, name: 'work' }, { id: 2 }, { id: 3 }, { id: 1 }, { id: 'x' }], nope: [{ id: 2 }] })).toEqual({
      codex: [
        { id: 2, name: '' },
        { id: 3, name: 'work' },
      ],
    })
    expect(accountList(null)).toEqual({})
    expect(nextAccountId({ codex: [{ id: 2, name: '' }, { id: 4, name: '' }] }, 'codex')).toBe(3)
    expect(nextAccountId({}, 'gemini')).toBe(2)
  })

  it('drops limits that already lifted', () => {
    expect(limitsOf({ codex: { 2: 2000, 3: 500 }, nope: { 2: 2000 } }, 1000)).toEqual({ codex: { 2: 2000 } })
  })
})

describe('picking an account', () => {
  const all = () => true
  it('takes the first signed in one that is not held', () => {
    expect(pickAccount([1, 2, 3], all, { 1: 5000 }, 1000)).toBe(2)
    expect(pickAccount([1, 2, 3], id => id !== 2, { 1: 5000 }, 1000)).toBe(3)
    expect(pickAccount([1, 2, 3], all, { 1: 500 }, 1000)).toBe(1)
  })

  it('moves on from the one a limit holds, wrapping round, never back to it', () => {
    expect(pickAccount([1, 2, 3], all, undefined, 0, 2)).toBe(3)
    expect(pickAccount([1, 2, 3], all, undefined, 0, 3)).toBe(1)
    expect(pickAccount([1, 2], all, { 1: 5000 }, 0, 2)).toBeNull()
  })

  it('has nothing to pick with one account or all held', () => {
    expect(pickAccount([1], all, undefined, 0)).toBeNull()
    expect(pickAccount([1, 2], all, { 1: 5000, 2: 5000 }, 1000)).toBeNull()
  })
})

describe('an account home', () => {
  it('links the shared history and copies the settings when they change', () => {
    const p = paths()
    const spec = accountSpec('claude')!
    const base = defaultBase({ ...p, claudeDir: join(p.home, 'claude') }, 'claude')
    mkdirSync(join(base, 'projects', 'a'), { recursive: true })
    writeFileSync(join(base, 'settings.json'), '{"a":1}')
    const home = homeOf(p, 'claude', 2)
    prepareHome(spec, base, home)
    expect(lstatSync(join(home, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(home, 'projects'))).toBe(join(base, 'projects'))
    expect(existsSync(join(home, 'projects', 'a'))).toBe(true)
    // A folder the default home lacks is made there, so both see what either writes.
    expect(existsSync(join(base, 'todos'))).toBe(true)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"a":1}')

    // The account's own change stays until the default home's file changes again.
    writeFileSync(join(home, 'settings.json'), '{"mine":1}')
    prepareHome(spec, base, home)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"mine":1}')
    writeFileSync(join(base, 'settings.json'), '{"a":2}')
    const later = new Date(Date.now() + 5000)
    utimesSync(join(base, 'settings.json'), later, later)
    prepareHome(spec, base, home)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"a":2}')
  })

  it('leaves a folder the CLI made in the account home as it is', () => {
    const p = paths()
    const spec = accountSpec('codex')!
    const base = join(p.home, '.codex')
    const home = homeOf(p, 'codex', 2)
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'own.jsonl'), 'x')
    prepareHome(spec, base, home)
    expect(lstatSync(join(home, 'sessions')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(home, 'sessions', 'own.jsonl'), 'utf8')).toBe('x')
  })
})

describe('the account of a run', () => {
  it('adds nothing while the agent has one account', () => {
    expect(runAccount(paths(), 'codex')).toBeNull()
  })

  it('runs on the first free account, with its home in the env', () => {
    const p = paths()
    keep(p, { codex: [{ id: 2, name: '' }] })
    // Account 2 has not signed in: the default login.
    expect(runAccount(p, 'codex', undefined, 1000)).toEqual({ id: 1, env: { SWITCHBOARD_ACCOUNT: '1' } })
    mkdirSync(homeOf(p, 'codex', 2), { recursive: true })
    writeFileSync(join(homeOf(p, 'codex', 2), 'auth.json'), '{}')
    markLimit(p, 'codex', 1, 5000, 1000)
    expect(runAccount(p, 'codex', undefined, 1000)).toEqual({ id: 2, env: { CODEX_HOME: homeOf(p, 'codex', 2), SWITCHBOARD_ACCOUNT: '2' } })
    // Asked for one, that one.
    expect(runAccount(p, 'codex', 1, 1000)?.id).toBe(1)
  })

  it('brings the default account\'s folder trust and MCP servers into a Claude account', () => {
    const p = paths()
    keep(p, { claude: [{ id: 2, name: '' }] })
    const home = homeOf(p, 'claude', 2)
    const own = { oauthAccount: { emailAddress: 'two@example.com' }, projects: { '/b': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } }
    writeFileSync(join(p.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@example.com' }, mcpServers: { db: { command: 'db' } }, projects: { '/a': { hasTrustDialogAccepted: true, mcpServers: { web: { command: 'web' } }, enabledMcpjsonServers: ['local'], history: ['hi'] }, '/b': { hasTrustDialogAccepted: false } } }))
    // Before the login there is no file of the account's to add to.
    runAccount(p, 'claude', 2)
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    writeFileSync(join(home, '.claude.json'), JSON.stringify(own))
    expect(runAccount(p, 'claude', 2)?.env.CLAUDE_CONFIG_DIR).toBe(home)
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({
      oauthAccount: { emailAddress: 'two@example.com' },
      mcpServers: { db: { command: 'db' } },
      projects: {
        '/a': { hasTrustDialogAccepted: true, mcpServers: { web: { command: 'web' } }, enabledMcpjsonServers: ['local'] },
        // The account's own trust stays; a folder the default account never trusted is not trusted for it.
        '/b': { hasTrustDialogAccepted: true, allowedTools: ['x'] },
      },
    })
  })

  it('leaves the Claude state file alone when nothing changes or a file cannot be read', () => {
    const base = JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true } } })
    expect(claudeStateText(base, JSON.stringify({ projects: { '/a': { hasTrustDialogAccepted: true } } }))).toBeNull()
    expect(claudeStateText(base, '{ half')).toBeNull()
    expect(claudeStateText('[]', '{}')).toBeNull()
    expect(JSON.parse(claudeStateText(base, '{}')!)).toEqual({ projects: { '/a': { hasTrustDialogAccepted: true } } })
  })

  it('gives Qwen its own home and the shared runtime folder', () => {
    const p = paths()
    keep(p, { qwen: [{ id: 2, name: '' }] })
    expect(runAccount(p, 'qwen', 2)?.env).toEqual({ QWEN_HOME: homeOf(p, 'qwen', 2), QWEN_RUNTIME_DIR: join(p.home, '.qwen'), SWITCHBOARD_ACCOUNT: '2' })
  })

  it('keeps the later of two limits', () => {
    const p = paths()
    markLimit(p, 'gemini', 2, 5000, 1000)
    markLimit(p, 'gemini', 2, 3000, 1000)
    expect(readLimits(p, 1000)).toEqual({ gemini: { 2: 5000 } })
  })

  it('lists every agent with its default account first', () => {
    const p = paths()
    keep(p, { gemini: [{ id: 2, name: 'side' }] })
    mkdirSync(join(homeOf(p, 'gemini', 2), '.gemini'), { recursive: true })
    writeFileSync(join(homeOf(p, 'gemini', 2), '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'someone@example.com' }))
    const gemini = accountRows(p).find(r => r.agent === 'gemini')!
    expect(gemini.accounts).toEqual([
      { id: 1, name: '', email: '', signedIn: true, until: undefined, usage: undefined },
      { id: 2, name: 'side', email: 'so****@example.com', signedIn: false, until: undefined, usage: undefined },
    ])
    expect(gemini.active).toBe(1)
  })
})

describe('the account in use', () => {
  it('keeps a picked account only while it is on the list', () => {
    const list = { codex: [{ id: 2, name: '' }] }
    expect(activeOf({ active: { codex: 2, gemini: 3, nope: 1 } }, list)).toEqual({ codex: 2 })
    expect(activeOf({ active: { codex: 1 } }, list)).toEqual({ codex: 1 })
    expect(activeOf({}, list)).toEqual({})
  })

  it('tries the picked account first', () => {
    expect(accountOrder([1, 2, 3], 3)).toEqual([3, 1, 2])
    expect(accountOrder([1, 2, 3], 9)).toEqual([1, 2, 3])
    expect(accountOrder([1, 2, 3], undefined)).toEqual([1, 2, 3])
  })

  it('starts new runs on the picked account, and on the next one while it is held', () => {
    const p = paths()
    keep(p, { codex: [{ id: 2, name: '' }, { id: 3, name: '' }], active: { codex: 3 } })
    for (const id of [2, 3]) {
      mkdirSync(homeOf(p, 'codex', id), { recursive: true })
      writeFileSync(join(homeOf(p, 'codex', id), 'auth.json'), '{}')
    }
    expect(runAccount(p, 'codex', undefined, 1000)?.id).toBe(3)
    markLimit(p, 'codex', 3, 5000, 1000)
    expect(runAccount(p, 'codex', undefined, 1000)?.id).toBe(1)
    expect(accountRows(p, {}, 1000).find(r => r.agent === 'codex')?.active).toBe(3)
  })

  it('takes each account\'s usage from the latest report of its live sessions', () => {
    const runs = new Map([
      ['k1', { agent: 'codex', account: 2, cwd: '/a' }],
      ['k2', { agent: 'codex', account: 2, cwd: '/b' }],
      ['k3', { agent: 'claude', account: 1, cwd: '/c' }],
    ])
    const usage = (five: number, week?: number) => JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: five }, ...(week === undefined ? [] : [{ kind: 'seven_day', percentUsed: week }])] })
    expect(
      accountUsageOf(
        [
          { terminal: 'k1', usage: usage(10, 5), last_seen: 1 },
          { terminal: 'k2', usage: usage(40, 20), last_seen: 2 },
          { terminal: 'k3', usage: '{}', last_seen: 3 },
          { terminal: 'other', usage: usage(99), last_seen: 4 },
        ],
        runs,
      ),
    ).toEqual({ codex: { 2: { five: 40, week: 20 } } })
  })
})
