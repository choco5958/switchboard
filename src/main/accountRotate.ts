import { accountSpec, pickAccount, SCREEN_LIMIT_MS } from '../shared/accounts'
import { CONTINUE_LAST, agentOf, resumableId } from '../shared/agents'
import { limitedUntil } from '../shared/limit'
import { t } from '../shared/i18n'
import type { Reply } from '../shared/types'
import type { TypingTarget } from './agentInput'
import { accountRuns, markLimit, readAccounts, readLimits, signedIn, type AccountPaths, type AccountRun } from './accounts'

// A session the app started on an account (accounts.ts accountRuns) that hits the account's limit
// goes on on the next free account of its CLI (docs/계정-여러-개.md): its CLI is ended in its
// terminal, the same conversation opens in a new terminal on the next account, and that session is
// asked to carry on. With no free account it waits for the reset as before (src/shared/limit.ts).
//
// The limit is read from the session's usage report where the CLI sends one (Claude Code through the
// mod, Codex through its app-server), else from the text the CLI shows at the bottom of its screen.

export const CHECK_EVERY_MS = 15_000
// How much of the screen's end the limit text is looked for in: the CLI shows it by its prompt.
const SCREEN_TAIL = 12
const EXIT_WAIT_MS = 15_000
// Ctrl-C presses that end a CLI, and the pause between them (scripts/account-check.ts --limit).
export const EXIT_PRESSES = 4
export const EXIT_PRESS_MS = 700
const SESSION_WAIT_MS = 90_000
const REPORTS_USAGE = ['claude', 'codex']

type Session = { id: string; terminal?: string; usage?: string; last_seen?: number }

export type RotateDeps = {
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply & { proven?: boolean }>
  paths: () => AccountPaths
  terminal: (key: string) => TypingTarget | undefined
  // Opens the run's conversation on the account in a new terminal; the key names that terminal.
  open: (run: AccountRun, account: number, resume: string) => Promise<{ key: string } | { error: string }>
  notify: (text: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Whether the end of the screen shows the CLI's limit text.
export function screenLimited(agent: string, screen: readonly string[] | undefined): boolean {
  const spec = accountSpec(agent)
  if (!spec?.limit || !screen) return false
  const tail = screen.filter(row => row.trim()).slice(-SCREEN_TAIL)
  return spec.limit.test(tail.join('\n'))
}

// The CLI is in front of its terminal (not the shell it was started from).
const cliInFront = (target: TypingTarget): boolean => !!target.foreground && (target.expect ?? []).some(bin => target.foreground === bin || target.foreground.endsWith(`/${bin}`))

export function startRotation(deps: RotateDeps): { check: () => Promise<void>; stop: () => void } {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let running = false

  const label = (agent: string) => agentOf(agent)?.label ?? agent

  const move = async (key: string, run: AccountRun, until: number, session: Session | undefined, target: TypingTarget) => {
    accountRuns.delete(key)
    const paths = deps.paths()
    markLimit(paths, run.agent, run.account, until, now())
    const ids = [1, ...(readAccounts(paths)[run.agent] ?? []).map(e => e.id)]
    const next = pickAccount(ids, id => signedIn(paths, run.agent, id), readLimits(paths, now())[run.agent], now(), run.account)
    if (next === null) return deps.notify(t('accounts.allLimited', { agent: label(run.agent) }))
    // The CLI ends first, so two runs never write the same conversation.
    // A CLI may first close a dialog of its own (Gemini's limit dialog) before asking for a second press.
    for (let press = 0; press < EXIT_PRESSES && (target.platform === 'win32' || cliInFront(target)); press++) {
      target.write('\x03')
      await sleep(EXIT_PRESS_MS)
    }
    const end = now() + EXIT_WAIT_MS
    if (target.platform === 'win32') await sleep(3000)
    else while (cliInFront(target) && now() < end) await sleep(300)
    if (target.platform !== 'win32' && cliInFront(target)) return deps.notify(t('accounts.moveFailed', { agent: label(run.agent), n: next }))
    const resume = run.agent === 'claude' && session && resumableId(session.id) ? session.id : CONTINUE_LAST
    const opened = await deps.open(run, next, resume)
    if ('error' in opened) return deps.notify(t('accounts.moveFailed', { agent: label(run.agent), n: next }))
    deps.notify(t('accounts.moved', { agent: label(run.agent), from: run.account, n: next }))
    // The new session takes the turn back up once it is there.
    const until2 = now() + SESSION_WAIT_MS
    while (now() < until2) {
      await sleep(1500)
      const reply = await deps.call('GET', '/state').catch(() => null)
      const fresh = ((reply?.json.sessions ?? []) as Session[]).find(s => s.terminal === opened.key)
      if (fresh) {
        await deps.call('POST', '/outbox', { sessionId: fresh.id, text: t('accounts.continuePrompt'), kind: '메시지', taskTitle: '' }).catch(() => undefined)
        return
      }
    }
  }

  const check = async () => {
    if (running || accountRuns.size === 0) return
    running = true
    try {
      // Typing into terminals goes only by what a bridge that proved the app's key says.
      const reply = await deps.call('GET', '/state').catch(() => null)
      if (!reply?.ok || !reply.proven) return
      const sessions = (reply.json.sessions ?? []) as Session[]
      for (const [key, run] of [...accountRuns]) {
        const target = deps.terminal(key)
        if (!target?.alive) {
          accountRuns.delete(key)
          continue
        }
        const session = sessions.find(s => s.terminal === key)
        const until = REPORTS_USAGE.includes(run.agent)
          ? session
            ? limitedUntil(session.usage, session.last_seen ?? now(), now())
            : null
          : cliInFront(target) && screenLimited(run.agent, target.screen)
            ? now() + SCREEN_LIMIT_MS
            : null
        if (until !== null) await move(key, run, until, session, target)
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void check(), CHECK_EVERY_MS)
  timer.unref?.()
  return { check, stop: () => clearInterval(timer) }
}
