import { describe, expect, test } from 'vitest'
import type { GraphNode, Question, Task } from '../../shared/types'
import { ago, attentionOf, keyAction, layoutGraph, nextAfter, optionsOf, queueOf, reachOf, reviewLoops, stageCounts, stations, stripTaskPrefix, taskOfEvent, tasksByProject, waitingFirst } from './model'

const q = (id: number, status: Question['status'] = 'pending'): Question => ({
  id,
  session_id: 's',
  project: 'p',
  task_title: '',
  question: `Q${id}`,
  body: '',
  options: JSON.stringify([
    { key: 'a', label: '하나' },
    { key: 'b', label: '둘' },
  ]),
  recommend: 'a',
  reason: '',
  status,
  choice: null,
  memo: null,
  created_at: 0,
  answered_at: null,
  delivered: 0,
  turn_id: '',
})

describe('queue', () => {
  test('oldest pending first, held apart, answered left out', () => {
    const { pending, held } = queueOf([q(3), q(1), q(2, 'held'), q(4, 'answered')])
    expect(pending.map(one => one.id)).toEqual([1, 3])
    expect(held.map(one => one.id)).toEqual([2])
  })

  test('next selection moves forward, then wraps, then empties', () => {
    const list = [q(1), q(3), q(5)]
    expect(nextAfter(list, 3)).toBe(5)
    expect(nextAfter(list, 5)).toBe(1)
    expect(nextAfter([q(5)], 5)).toBeNull()
  })

  test('broken options read as none', () => {
    expect(optionsOf({ ...q(1), options: 'not json' })).toEqual([])
  })
})

describe('keys', () => {
  const options = optionsOf(q(1))
  test('an option key or its number picks it', () => {
    expect(keyAction('b', options)).toEqual({ type: 'choose', key: 'b' })
    expect(keyAction('B', options)).toEqual({ type: 'choose', key: 'b' })
    expect(keyAction('1', options)).toEqual({ type: 'choose', key: 'a' })
    expect(keyAction('9', options)).toEqual({ type: 'none' })
  })

  test('Enter sends, h holds, m opens the memo', () => {
    expect(keyAction('Enter', options)).toEqual({ type: 'send' })
    expect(keyAction('h', options)).toEqual({ type: 'hold' })
    expect(keyAction('m', options)).toEqual({ type: 'memo' })
  })

  test('an option keyed h wins over hold', () => {
    expect(keyAction('h', [{ key: 'h', label: '높게' }])).toEqual({ type: 'choose', key: 'h' })
  })
})

test('tasks group by project, sorted', () => {
  const task = (project: string, title: string) => ({ project, title }) as Task
  const groups = tasksByProject([task('shop', 'a'), task('blog', 'b'), task('shop', 'c')])
  expect(groups.map(([project, list]) => [project, list.length])).toEqual([
    ['blog', 1],
    ['shop', 2],
  ])
})

test('relative time', () => {
  expect(ago(0, 30_000)).toBe('30초 전')
  expect(ago(0, 5 * 60_000)).toBe('5분 전')
  expect(ago(0, 3 * 3_600_000)).toBe('3시간 전')
})

describe('graph layout', () => {
  const node = (key: string, after: string[] = [], extra: Partial<GraphNode> = {}): GraphNode =>
    ({ key, title: key, after: JSON.stringify(after), status: '대기', stage: null, ...extra }) as GraphNode

  test('a node sits one column right of its latest predecessor', () => {
    const { placed, edges, cols, rows } = layoutGraph([
      node('spec'),
      node('a', ['spec']),
      node('b', ['spec']),
      node('merge', ['a', 'b']),
    ])
    const at = (key: string) => placed.find(p => p.node.key === key)
    expect([at('spec')?.col, at('a')?.col, at('b')?.col, at('merge')?.col]).toEqual([0, 1, 1, 2])
    expect([at('a')?.row, at('b')?.row]).toEqual([0, 1])
    expect(edges).toContainEqual(['a', 'merge'])
    expect([cols, rows]).toEqual([3, 2])
  })

  test('a cycle or unknown predecessor still places every node', () => {
    const { placed } = layoutGraph([node('x', ['y']), node('y', ['x']), node('z', ['ghost'])])
    expect(placed).toHaveLength(3)
    expect(placed.every(p => p.col >= 0)).toBe(true)
  })

  test('stage counts', () => {
    const counts = stageCounts([
      node('a', [], { stage: '요구', status: '끝' }),
      node('b', [], { stage: '작업' }),
      node('c', [], { stage: '작업', status: '끝' }),
    ])
    expect(counts.map(c => `${c.stage} ${c.done}/${c.total}`)).toEqual(['요구 1/1', '설계 0/0', '작업 1/2', '완료 0/0'])
  })
})

describe('review loops', () => {
  const n = (key: string, after: string[], extra: Partial<GraphNode> = {}): GraphNode =>
    ({ key, title: key, after: JSON.stringify(after), status: '끝', kind: '구현', round: 1, stage: null, ...extra }) as GraphNode

  test('a node in its second round loops back from the review after it', () => {
    const loops = reviewLoops([
      n('build', [], { round: 2, status: '지금' }),
      n('other', []),
      n('review', ['build', 'other'], { kind: '검토' }),
      n('ship', ['review']),
    ])
    expect(loops).toEqual([{ from: 'review', to: 'build', round: 2 }])
  })

  test('no loop for first rounds or reviews not started', () => {
    expect(reviewLoops([n('a', [], { round: 2 }), n('r', ['a'], { kind: '검토', status: '대기' })])).toEqual([])
    expect(reviewLoops([n('a', []), n('r', ['a'], { kind: '검토' })])).toEqual([])
  })

  test('stations name this stage and the next', () => {
    expect(stations('작업')).toEqual({ now: '작업', next: '완료' })
    expect(stations('완료')).toEqual({ now: '완료', next: null })
  })
})

describe('log lines', () => {
  test('drop the [task::node] prefix of agent descriptions', () => {
    expect(stripTaskPrefix('running: [메인 시나리오 E2E 회귀::s1] 시나리오1 지적 반영')).toBe('running: 시나리오1 지적 반영')
    expect(stripTaskPrefix('[a::b]할 일')).toBe('할 일')
    expect(stripTaskPrefix('[보통 괄호] 그대로')).toBe('[보통 괄호] 그대로')
  })

  test('find the task of a line by session and title', () => {
    const tasks = [
      { id: 1, session_id: 's1', title: 'A' },
      { id: 2, session_id: 's2', title: 'A' },
    ]
    expect(taskOfEvent(tasks, { session_id: 's2', task_title: 'A' })?.id).toBe(2)
    expect(taskOfEvent(tasks, { session_id: 's1', task_title: '' })).toBeNull()
    expect(taskOfEvent(tasks, { session_id: 's3', task_title: 'A' })).toBeNull()
  })
})

test('an answer reaches a live session; a gone one waits; an outside CLI is unknown', () => {
  expect(reachOf({ id: 's1', agent: 'claude', terminal: '' }, ['s1'])).toBe('live')
  expect(reachOf({ id: 's1', agent: 'claude', terminal: '' }, [])).toBe('gone')
  expect(reachOf({ id: 's2', terminal: '' }, [])).toBe('gone')
  expect(reachOf({ id: 's3', agent: 'codex', terminal: 't1' }, [])).toBe('gone')
  expect(reachOf({ id: 's4', agent: 'codex', terminal: '' }, [])).toBe('unknown')
  expect(reachOf(undefined, [])).toBe('gone')
})

test('a task needs the person for a decision first, then a stall, then a dropped session', () => {
  const base = { openQuestions: 0, stalled: false, offline: false, running: true }
  expect(attentionOf(base)).toBe(null)
  expect(attentionOf({ ...base, openQuestions: 1, stalled: true })).toBe('question')
  expect(attentionOf({ ...base, stalled: true, offline: true })).toBe('stalled')
  expect(attentionOf({ ...base, offline: true })).toBe('offline')
  expect(attentionOf({ ...base, offline: true, running: false })).toBe(null)
  expect(attentionOf({ ...base, openQuestions: 2, running: false })).toBe('question')
})

test('waiting tasks come first, strongest reason then newest', () => {
  const tasks = [
    { id: 1, updated_at: 10, why: null },
    { id: 2, updated_at: 20, why: 'offline' },
    { id: 3, updated_at: 5, why: 'question' },
    { id: 4, updated_at: 30, why: 'question' },
  ] as const
  const { waiting, rest } = waitingFirst([...tasks], task => task.why)
  expect(waiting.map(task => task.id)).toEqual([4, 3, 2])
  expect(rest.map(task => task.id)).toEqual([1])
})
