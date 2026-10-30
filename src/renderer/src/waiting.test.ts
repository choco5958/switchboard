import { describe, expect, test } from 'vitest'
import type { Approval, Question, Task } from '../../shared/types'
import { setLang } from '../../shared/i18n'
import { taskFacts, type Attention } from './model'
import { NO_WAIT, waitCount, waitParts } from './waiting'

const task = (id: number, session_id: string, title = `T${id}`) => ({ id, session_id, title, stage: '작업', status: '하는 중' }) as Task
const question = (id: number, status: Question['status'], session_id = 's1', task_title = 'T1') => ({ id, status, session_id, task_title }) as Question
const approval = (id: number, status: Approval['status']) => ({ id, status }) as Approval

describe('waitCount', () => {
  test('nothing waiting is all zeros', () => {
    expect(waitCount({ questions: [], tasks: [] }, () => null)).toEqual(NO_WAIT)
  })

  test('pending questions and approvals count; held, answered and expired do not', () => {
    const count = waitCount(
      {
        questions: [question(1, 'pending'), question(2, 'held'), question(3, 'answered'), question(4, 'pending')],
        approvals: [approval(1, 'pending'), approval(2, 'allow'), approval(3, 'expired')],
        tasks: [],
      },
      () => null,
    )
    expect(count).toEqual({ ...NO_WAIT, questions: 2, approvals: 1, total: 3 })
  })

  test('tasks count by their reason, and a task waiting on a question is not counted twice', () => {
    const why: Record<number, Attention | null> = { 1: 'question', 2: 'stalled', 3: 'limited', 4: 'offline', 5: null, 6: 'stalled' }
    const tasks = [1, 2, 3, 4, 5, 6].map(id => task(id, `s${id}`))
    const count = waitCount({ questions: [question(1, 'pending')], tasks }, one => why[one.id] ?? null)
    expect(count).toEqual({ questions: 1, approvals: 0, stalled: 2, limited: 1, offline: 1, total: 5 })
  })

  test('agrees with the task facts the sidebar lists', () => {
    const tasks = [task(1, 's1', 'A'), task(2, 's2', 'B'), task(3, 's3', 'C')]
    const questions = [question(1, 'pending', 's1', 'A')]
    // s1 waits on a question and is also stalled: it counts once, as the question.
    const facts = taskFacts(
      { tasks, questions, nodes: [], sessions: tasks.map(one => ({ id: one.session_id, agent: 'claude', terminal: '' })), live: ['s1', 's2', 's3'] },
      new Set(['s1', 's2']),
      new Set(['s3']),
      () => true,
    )
    const count = waitCount({ questions, tasks }, one => facts.get(one.id)?.attention ?? null)
    expect(count).toEqual({ questions: 1, approvals: 0, stalled: 1, limited: 1, offline: 0, total: 3 })
  })
})

test('waitParts names the parts that are not zero', () => {
  setLang('ko')
  expect(waitParts({ ...NO_WAIT, questions: 2, approvals: 1, total: 3 })).toBe('결정 질문 2, 권한 확인 1')
  expect(waitParts(NO_WAIT)).toBe('')
  setLang('en')
  expect(waitParts({ ...NO_WAIT, offline: 1, total: 1 })).toBe('1 disconnected task')
  setLang('ko')
})
