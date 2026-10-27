import { describe, expect, test } from 'vitest'
import type { GraphNode, LogEvent, Question, Task } from '../../shared/types'
import { artifactFromNotes, countLabel, flipTheme, isLight, nodeDetailKey, resetText, taskEvents, taskQuestions, testsFromNotes } from './taskInfo'

const task = (session_id: string): Task =>
  ({ id: session_id === 's1' ? 1 : 2, session_id, project: 'p', title: '같은 제목', stage: '작업', status: '하는 중' }) as Task
const question = (id: number, session_id: string): Question =>
  ({ id, session_id, project: 'p', task_title: '같은 제목', status: 'pending' }) as Question
const event = (id: number, session_id: string): LogEvent => ({ id, ts: id, session_id, project: 'p', task_title: '같은 제목', kind: '작업', text: '' })
const node = (over: Partial<GraphNode>): GraphNode =>
  ({ id: 1, task_id: 1, key: 'n', title: '', kind: '구현', owner: '작업자', stage: '작업', status: '끝', after: '[]', round: 1, note: '', updated_at: 0, worktree: null, branch: null, ...over }) as GraphNode

describe('task scoping', () => {
  test('two sessions in one project with the same task title do not mix', () => {
    const questions = [question(1, 's1'), question(2, 's2')]
    expect(taskQuestions(questions, task('s1')).map(q => q.id)).toEqual([1])
    expect(taskQuestions(questions, task('s2')).map(q => q.id)).toEqual([2])
    expect(taskEvents([event(1, 's1'), event(2, 's2')], task('s2')).map(e => e.id)).toEqual([2])
  })

  test('the node detail key differs for same-key nodes of two tasks', () => {
    const a = node({ id: 10, key: 'plan', worktree: '/wt/a' })
    const b = node({ id: 20, key: 'plan', task_id: 2, worktree: '/wt/b' })
    expect(nodeDetailKey(a)).not.toBe(nodeDetailKey(b))
    expect(nodeDetailKey(a)).not.toBe(nodeDetailKey({ ...a, worktree: '/wt/other' }))
  })
})

describe('auto-filled header fields', () => {
  const nodes = [
    node({ note: 'PR #364', updated_at: 1 }),
    node({ note: '검토 끝, PR #366 머지해도 됨. 통과 304, 실패 0', updated_at: 3 }),
    node({ note: 'pr #364 다시', updated_at: 2 }),
  ]
  test('PRs newest first, each once', () => expect(artifactFromNotes(nodes)).toBe('PR #366, PR #364'))
  test('the newest test line', () => expect(testsFromNotes(nodes)).toBe('통과 304, 실패 0'))
  test('nothing found', () => expect(artifactFromNotes([node({ note: '지적 4건' })])).toBe(''))
})

describe('top bar helpers', () => {
  const now = Date.parse('2026-10-27T10:00:00Z')
  test('reset text from ISO, epoch seconds and far dates', () => {
    expect(resetText('2026-10-27T11:44:00Z', now)).toBe('1시간 44분 뒤 초기화')
    expect(resetText(String(now / 1000 + 300), now)).toBe('5분 뒤 초기화')
    expect(resetText('2026-10-31T14:00:00Z', now)).toBe('4일 4시간 뒤 초기화')
    expect(resetText(undefined, now)).toBe('')
    expect(resetText('soon', now)).toBe('')
  })
  test('light switch goes to the light theme and back to the last dark one', () => {
    expect(flipTheme('tvision', undefined, 'a3')).toEqual({ theme: 'metro', lastDark: 'tvision' })
    expect(flipTheme('metro', 'tvision', 'a3')).toEqual({ theme: 'tvision', lastDark: 'tvision' })
    expect(flipTheme('metro', undefined, 'a3').theme).toBe('a3')
  })
  test('light themes count as light, and Solarized flips to its other half', () => {
    expect(isLight('solarizedlight')).toBe(true)
    expect(isLight('githublight')).toBe(true)
    expect(isLight('dracula')).toBe(false)
    expect(flipTheme('solarizeddark', 'nord', 'a3')).toEqual({ theme: 'solarizedlight', lastDark: 'solarizeddark' })
    expect(flipTheme('solarizedlight', 'nord', 'a3')).toEqual({ theme: 'solarizeddark', lastDark: 'solarizeddark' })
    expect(flipTheme('githublight', 'nord', 'a3')).toEqual({ theme: 'nord', lastDark: 'nord' })
    expect(flipTheme('dracula', undefined, 'a3')).toEqual({ theme: 'metro', lastDark: 'dracula' })
  })
  test('scoped counts show the total too', () => {
    expect(countLabel('결정', 3, null)).toBe('결정 3')
    expect(countLabel('결정', 3, 1)).toBe('결정 1 (전체 3)')
  })
})
