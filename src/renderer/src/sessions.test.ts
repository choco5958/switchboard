import { describe, expect, test } from 'vitest'
import type { Approval, Question, Session, Task, TermInfo } from '../../shared/types'
import { rowsByProject, sessionRows, type RowInput } from './sessions'

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, project: 'p', cwd: '/w/p', started_at: 1, last_seen: 1, usage: '', agent: 'claude', ...over })
const term = (id: string, over: Partial<TermInfo> = {}): TermInfo => ({ id, project: 'p', cwd: '/w/p', title: 'claude', claude: true, alive: true, exitCode: null, ...over })
const task = (id: number, session_id: string, over: Partial<Task> = {}): Task => ({ id, session_id, project: 'p', title: `작업 ${id}`, stage: '작업', status: '하는 중', updated_at: id, ...over }) as Task
const question = (id: number, session_id: string): Question => ({ id, session_id, project: 'p', task_title: '', question: `Q${id}`, status: 'pending' }) as Question
const ask = (id: number, session_id: string): Approval => ({ id, session_id, project: 'p', status: 'pending' }) as Approval

const input = (over: Partial<RowInput>): RowInput => ({
  sessions: [],
  live: [],
  tasks: [],
  questions: [],
  approvals: [],
  terms: [],
  stalled: new Set(),
  limited: new Set(),
  projectOf: (_cwd, fallback) => fallback,
  ...over,
})

describe('sidebar session rows', () => {
  test('a session that took delegated work names the project of the session that gave it', () => {
    const from = session('lead', { project: 'shop' })
    const took = session('s2', { terminal: 't2', agent: 'codex' })
    const work = { id: 1, from_session: 'lead', agent: 'codex', project: 'shop', cwd: '/w/p', status: 'sent' as const, session_id: 's2', failure: '', created_at: 1 }
    const rows = sessionRows(input({ sessions: [from, took], live: ['s2'], terms: [term('t2', { claude: false, agent: 'codex' })], delegations: [work] }))
    expect(rows.find(r => r.session?.id === 's2')?.delegatedBy).toBe('shop')
    expect(rows.find(r => r.session?.id === 'lead')?.delegatedBy).toBeUndefined()
  })

  test('a terminal shows the session in it, named by its running task', () => {
    const rows = sessionRows(input({ sessions: [session('s1', { terminal: 't1' })], live: ['s1'], tasks: [task(1, 's1')], terms: [term('t1')] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'term:t1', title: '작업 1', state: 'working', agent: 'claude' })
  })

  test('two Claude terminals in one folder each get their own session by terminal', () => {
    const rows = sessionRows(
      input({
        sessions: [session('s1', { terminal: 't1' }), session('s2', { terminal: 't2' })],
        live: ['s1', 's2'],
        questions: [question(7, 's2')],
        terms: [term('t1'), term('t2', { title: 'claude 2' })],
      }),
    )
    expect(rows.map(r => [r.key, r.session?.id, r.state])).toEqual([
      ['term:t1', 's1', 'idle'],
      ['term:t2', 's2', 'question'],
    ])
  })

  test('the strongest need wins: a question, then a permission ask, then a stall', () => {
    const base = { sessions: [session('s1', { terminal: 't1' })], live: ['s1'], terms: [term('t1')], tasks: [task(1, 's1')] }
    expect(sessionRows(input({ ...base, questions: [question(1, 's1')], approvals: [ask(1, 's1')] }))[0]!.state).toBe('question')
    expect(sessionRows(input({ ...base, approvals: [ask(1, 's1')], stalled: new Set(['s1']) }))[0]!.state).toBe('approval')
    expect(sessionRows(input({ ...base, stalled: new Set(['s1']) }))[0]!.state).toBe('stalled')
    expect(sessionRows(input({ ...base, limited: new Set(['s1']) }))[0]!.state).toBe('limited')
  })

  test('sessions outside the app show while connected or still needing the person', () => {
    const rows = sessionRows(
      input({
        sessions: [session('out', { started_at: 2 }), session('old'), session('gone', { started_at: 3 }), session('asks', { started_at: 4 })],
        live: ['out'],
        tasks: [task(1, 'gone')],
        questions: [question(1, 'asks')],
      }),
    )
    expect(rows.map(r => [r.key, r.state])).toEqual([
      ['session:out', 'idle'],
      ['session:gone', 'offline'],
      ['session:asks', 'question'],
    ])
  })

  test('a closed terminal and a plain shell', () => {
    const rows = sessionRows(input({ terms: [term('t1', { alive: false, exitCode: 0 }), term('t2', { claude: false, title: 'zsh' })] }))
    expect(rows.map(r => [r.title, r.agent, r.state])).toEqual([
      ['claude', 'claude', 'ended'],
      ['zsh', 'shell', 'idle'],
    ])
  })

  test('rows group under their project', () => {
    const rows = sessionRows(input({ terms: [term('t1', { cwd: '/w/a' }), term('t2', { cwd: '/w/b' }), term('t3', { cwd: '/w/a' })], projectOf: cwd => cwd.slice(3) }))
    expect([...rowsByProject(rows)].map(([p, list]) => [p, list.map(r => r.key)])).toEqual([
      ['a', ['term:t1', 'term:t3']],
      ['b', ['term:t2']],
    ])
  })
})
