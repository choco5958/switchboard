// The sidebar's rows under each project: one per app terminal, and one per session that runs
// outside the app but still matters (connected, or with a question, permission ask or running
// task). A row says what it needs from the person first. Pure, so the rules are testable.
import type { Approval, Delegation, Question, Session, Task, TermInfo } from '../../shared/types'
import { isRunning } from '../../shared/projects'
import { terminalOf } from './taskInfo'

// The strongest first: what waits for an answer, then what went wrong, then what just runs.
export type RowState = 'question' | 'approval' | 'stalled' | 'limited' | 'offline' | 'working' | 'idle' | 'ended'

export type SessionRow = {
  key: string // 'term:<dock id>' or 'session:<session id>', the session view's address
  project: string
  cwd: string
  title: string
  agent: string // 'claude', another CLI's id, or 'shell'
  state: RowState
  session?: Session
  term?: TermInfo
  task?: Task
  questions: Question[] // pending, oldest first
  approvals: Approval[] // pending, oldest first
  delegatedBy?: string // the project of the session that handed this one its work (delegate)
}

export type RowInput = {
  sessions: readonly Session[]
  live: readonly string[]
  tasks: readonly Task[]
  questions: readonly Question[]
  approvals: readonly Approval[]
  terms: readonly TermInfo[]
  stalled: ReadonlySet<string>
  limited: ReadonlySet<string>
  projectOf: (cwd: string, fallback: string) => string
  delegations?: readonly Delegation[]
}

export const termKey = (id: string) => `term:${id}`
export const sessionKey = (id: string) => `session:${id}`

// The task a session works on now: its newest running one, else (while connected) its newest.
function taskOf(tasks: readonly Task[], session: Session, connected: boolean): Task | undefined {
  const own = tasks.filter(t => t.session_id === session.id).sort((a, b) => b.updated_at - a.updated_at)
  return own.find(isRunning) ?? (connected ? own[0] : undefined)
}

export function sessionRows(input: RowInput): SessionRow[] {
  const live = new Set(input.live)
  // Each terminal takes one session: a connected one before a gone one, the newest first.
  const ordered = [...input.sessions].sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)) || b.last_seen - a.last_seen)
  const inTerm = new Map<string, Session>()
  const placed = new Set<string>()
  for (const session of ordered) {
    const term = terminalOf(session, [...input.terms])
    if (!term || inTerm.has(term.id)) continue
    inTerm.set(term.id, session)
    placed.add(session.id)
  }
  const pendingOf = (id: string) => input.questions.filter(q => q.status === 'pending' && q.session_id === id).sort((a, b) => a.id - b.id)
  const asksOf = (id: string) => input.approvals.filter(a => a.status === 'pending' && a.session_id === id).sort((a, b) => a.id - b.id)

  const row = (key: string, session: Session | undefined, term: TermInfo | undefined): SessionRow => {
    const connected = !!session && live.has(session.id)
    const task = session ? taskOf(input.tasks, session, connected) : undefined
    const questions = session ? pendingOf(session.id) : []
    const approvals = session ? asksOf(session.id) : []
    const cwd = term?.cwd ?? session?.cwd ?? ''
    const project = input.projectOf(cwd, term?.project ?? session?.project ?? '')
    const agent = session?.agent || term?.agent || (term ? (term.claude ? 'claude' : 'shell') : 'claude')
    const state: RowState =
      questions.length > 0
        ? 'question'
        : approvals.length > 0
          ? 'approval'
          : session && input.stalled.has(session.id)
            ? 'stalled'
            : session && input.limited.has(session.id)
              ? 'limited'
              : term && !term.alive
                ? 'ended'
                : session && !connected && !term
                  ? task && isRunning(task)
                    ? 'offline'
                    : 'ended'
                  : task && isRunning(task)
                    ? 'working'
                    : 'idle'
    // The newest work handed to this session, by the session that gave it.
    const given = session ? [...(input.delegations ?? [])].reverse().find(d => d.session_id === session.id) : undefined
    const giver = given ? input.sessions.find(s => s.id === given.from_session) : undefined
    const delegatedBy = given ? (giver?.project ?? given.project) : undefined
    return { key, project, cwd, title: task?.title || term?.title || agent, agent, state, session, term, task, questions, approvals, ...(delegatedBy ? { delegatedBy } : {}) }
  }

  const rows = input.terms.map(term => row(termKey(term.id), inTerm.get(term.id), term))
  // Sessions outside the app's terminals: only those that are connected or still need the person.
  const outside = input.sessions
    .filter(s => !placed.has(s.id))
    .filter(s => live.has(s.id) || pendingOf(s.id).length > 0 || asksOf(s.id).length > 0 || input.tasks.some(t => t.session_id === s.id && isRunning(t)))
    .sort((a, b) => a.started_at - b.started_at)
  return [...rows, ...outside.map(s => row(sessionKey(s.id), s, undefined))]
}

// Rows by project, in the order the projects are listed; a project with no row has none here.
export function rowsByProject(rows: readonly SessionRow[]): Map<string, SessionRow[]> {
  const by = new Map<string, SessionRow[]>()
  for (const r of rows) by.set(r.project, [...(by.get(r.project) ?? []), r])
  return by
}

// What waits for the person in a row, for the badge on the right of it.
export const needsAnswer = (state: RowState) => state === 'question' || state === 'approval'
export const needsLook = (state: RowState) => state === 'stalled' || state === 'limited' || state === 'offline'
