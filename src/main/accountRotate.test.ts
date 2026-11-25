import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTINUE_LAST } from '../shared/agents'
import type { TypingTarget } from './agentInput'
import { accountRuns, homeOf, readLimits, type AccountPaths } from './accounts'
import { screenLimited, startRotation, type RotateDeps } from './accountRotate'

const dirs: string[] = []
afterEach(() => {
  accountRuns.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Two accounts of each agent given, account 2 signed in.
function paths(agents: string[]): AccountPaths {
  const home = mkdtempSync(join(tmpdir(), 'sb-rot-'))
  dirs.push(home)
  const p: AccountPaths = { root: join(home, '.claude-ide'), home, env: {} }
  mkdirSync(p.root, { recursive: true })
  writeFileSync(join(p.root, 'accounts.json'), JSON.stringify(Object.fromEntries(agents.map(a => [a, [{ id: 2, name: '' }]]))))
  for (const agent of agents) {
    const dir = homeOf(p, agent, 2)
    mkdirSync(join(dir, '.gemini'), { recursive: true })
    const file = { codex: 'auth.json', gemini: '.gemini/oauth_creds.json', qwen: 'settings.json', copilot: 'config.json' }[agent]
    if (file) writeFileSync(join(dir, file), '{}')
    if (agent === 'claude') writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com' } }))
  }
  return p
}

// A terminal whose CLI leaves the front after `exitsAfter` Ctrl-C presses.
function terminal(bin: string, screen: string[] = [], exitsAfter = 2): TypingTarget & { typed: string[] } {
  const typed: string[] = []
  const target = {
    alive: true,
    shell: '/bin/zsh',
    lastOutput: 0,
    paste: false,
    foreground: bin,
    expect: [bin],
    screen,
    platform: 'darwin',
    typed,
    write: (data: string) => {
      typed.push(data)
      if (typed.filter(d => d === '\x03').length >= exitsAfter) target.foreground = 'zsh'
    },
  }
  return target
}

// A Claude Code terminal as the app opens it: it names no programs, and macOS reads the CLI's name
// off the file the `claude` link points at (`claude.exe` from npm, the version from the installer).
function claudeTerminal(front = 'claude.exe', exitsAfter = 2): TypingTarget & { typed: string[] } {
  const target = terminal(front, [], exitsAfter)
  target.expect = []
  return target
}

const limited = JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(10_000_000).toISOString() }] })

function deps(p: AccountPaths, terms: Record<string, TypingTarget>, sessions: { id: string; terminal: string; usage?: string; last_seen?: number }[], proven = true) {
  const opened: { agent: string; account: number; resume: string }[] = []
  const posted: unknown[] = []
  const notes: string[] = []
  let clock = 1_000_000
  const d: RotateDeps = {
    call: async (method, path, body) => {
      if (method === 'POST') posted.push({ path, body })
      return { ok: true, status: 200, json: { sessions }, proven }
    },
    paths: () => p,
    terminal: key => terms[key],
    open: async (run, account, resume) => {
      opened.push({ agent: run.agent, account, resume })
      sessions.push({ id: 'new-session', terminal: 'k-new' })
      return { key: 'k-new' }
    },
    notify: text => notes.push(text),
    now: () => clock,
    sleep: async ms => void (clock += ms),
  }
  return { d, opened, posted, notes }
}

describe('moving a session at its limit to the next account', () => {
  it('reopens a Codex conversation on the next account when its usage report is full', async () => {
    const p = paths(['codex'])
    accountRuns.set('k1', { agent: 'codex', account: 1, cwd: '/work' })
    const term = terminal('codex')
    const { d, opened, posted } = deps(p, { k1: term }, [{ id: 'codex-1', terminal: 'k1', usage: limited, last_seen: 1_000_000 }])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(term.typed.filter(x => x === '\x03').length).toBe(2)
    expect(opened).toEqual([{ agent: 'codex', account: 2, resume: CONTINUE_LAST }])
    expect(readLimits(p, 1_000_000).codex?.['1']).toBeGreaterThan(1_000_000)
    expect(posted).toEqual([{ path: '/outbox', body: expect.objectContaining({ sessionId: 'new-session' }) }])
    expect(accountRuns.has('k1')).toBe(false)
  })

  it('goes on with the same Claude Code conversation by its id', async () => {
    const p = paths(['claude'])
    accountRuns.set('k1', { agent: 'claude', account: 1, cwd: '/work' })
    const term = claudeTerminal()
    const { d, opened } = deps(p, { k1: term }, [{ id: '11111111-2222-3333-4444-555555555555', terminal: 'k1', usage: limited, last_seen: 1_000_000 }])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(term.typed.filter(x => x === '\x03').length).toBe(2)
    expect(opened).toEqual([{ agent: 'claude', account: 2, resume: '11111111-2222-3333-4444-555555555555' }])
  })

  it('ends Claude Code under the name the native installer gives it, and opens nothing while it runs', async () => {
    const session = { id: '11111111-2222-3333-4444-555555555555', terminal: 'k1', usage: limited, last_seen: 1_000_000 }
    const p = paths(['claude'])
    accountRuns.set('k1', { agent: 'claude', account: 1, cwd: '/work' })
    const ends = claudeTerminal('2.1.327')
    const first = deps(p, { k1: ends }, [session])
    const rotation = startRotation(first.d)
    await rotation.check()
    rotation.stop()
    expect(ends.typed.filter(x => x === '\x03').length).toBe(2)
    expect(first.opened).toHaveLength(1)

    const q = paths(['claude'])
    accountRuns.set('k1', { agent: 'claude', account: 1, cwd: '/work' })
    const stays = claudeTerminal('2.1.327', 99)
    const second = deps(q, { k1: stays }, [session])
    const again = startRotation(second.d)
    await again.check()
    again.stop()
    expect(stays.typed.filter(x => x === '\x03').length).toBe(4)
    expect(second.opened).toEqual([])
    expect(second.notes).toHaveLength(1)
  })

  it('reads the limit off the screen for a CLI that sends no usage', async () => {
    const p = paths(['gemini'])
    accountRuns.set('k1', { agent: 'gemini', account: 2, cwd: '/work' })
    const screen = ['> fix the tests', '', 'You have exhausted your daily quota on this model.', '', '> ']
    const { d, opened } = deps(p, { k1: terminal('gemini', screen) }, [])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(opened).toEqual([{ agent: 'gemini', account: 1, resume: CONTINUE_LAST }])
  })

  it('waits for the reset when every account is held', async () => {
    const p = paths(['codex'])
    writeFileSync(join(p.root, 'account-limits.json'), JSON.stringify({ codex: { 2: 9_000_000 } }))
    accountRuns.set('k1', { agent: 'codex', account: 1, cwd: '/work' })
    const term = terminal('codex')
    const { d, opened, notes } = deps(p, { k1: term }, [{ id: 'c', terminal: 'k1', usage: limited, last_seen: 1_000_000 }])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(opened).toEqual([])
    expect(term.typed).toEqual([])
    expect(notes).toHaveLength(1)
  })

  it('holds an account added twice with the one at its limit, and does not reopen on it', async () => {
    const p = paths(['claude'])
    // Account 2 signed in as the login account 1 already has.
    const same = JSON.stringify({ oauthAccount: { emailAddress: 'one@example.com', accountUuid: 'A-1', organizationUuid: 'O-1' } })
    writeFileSync(join(p.home, '.claude.json'), same)
    writeFileSync(join(homeOf(p, 'claude', 2), '.claude.json'), same)
    accountRuns.set('k1', { agent: 'claude', account: 1, cwd: '/work' })
    const term = claudeTerminal()
    const { d, opened, notes } = deps(p, { k1: term }, [{ id: '11111111-2222-3333-4444-555555555555', terminal: 'k1', usage: limited, last_seen: 1_000_000 }])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(opened).toEqual([])
    expect(term.typed).toEqual([])
    expect(notes).toHaveLength(1)
    expect(Object.keys(readLimits(p, 1_000_000).claude ?? {})).toEqual(['1', '2'])
  })

  it('opens nothing when the CLI will not end', async () => {
    const p = paths(['codex'])
    accountRuns.set('k1', { agent: 'codex', account: 1, cwd: '/work' })
    const { d, opened, notes } = deps(p, { k1: terminal('codex', [], 99) }, [{ id: 'c', terminal: 'k1', usage: limited, last_seen: 1_000_000 }])
    const rotation = startRotation(d)
    await rotation.check()
    rotation.stop()
    expect(opened).toEqual([])
    expect(notes).toHaveLength(1)
  })

  it('does nothing on a bridge that has not proved the app key, or below the limit', async () => {
    const p = paths(['codex'])
    accountRuns.set('k1', { agent: 'codex', account: 1, cwd: '/work' })
    const unproven = deps(p, { k1: terminal('codex') }, [{ id: 'c', terminal: 'k1', usage: limited, last_seen: 1_000_000 }], false)
    await startRotation(unproven.d).check()
    expect(unproven.opened).toEqual([])
    const fine = deps(p, { k1: terminal('codex') }, [{ id: 'c', terminal: 'k1', usage: JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: 80 }] }), last_seen: 1_000_000 }])
    await startRotation(fine.d).check()
    expect(fine.opened).toEqual([])
  })
})

describe('the limit on the screen', () => {
  it('counts only the end of the screen', () => {
    const above = ['Usage limit reached for all Pro models.', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)]
    expect(screenLimited('gemini', above)).toBe(false)
    // Copilot's own limit text could not be checked with the real CLI: it is not looked for.
    expect(screenLimited('copilot', ['x', "You've run out of your included AI credits for the month."])).toBe(false)
    expect(screenLimited('qwen', ['Quota exhausted: try later'])).toBe(true)
    expect(screenLimited('opencode', ['Quota exhausted: '])).toBe(false)
  })
})
