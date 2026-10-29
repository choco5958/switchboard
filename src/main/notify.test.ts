import { describe, expect, test } from 'vitest'
import type { Question } from '../shared/types'
import { badgeText, firstLine, planNotification, scanPending, scanReleased, scanStalled } from './notify'

const q = (id: number, status: Question['status'] = 'pending', question = `q${id}`): Question =>
  ({ id, status, question, project: 'proj', session_id: 's' }) as Question

describe('scanPending', () => {
  test('first state is a baseline and notifies nothing', () => {
    const scan = scanPending([q(1), q(2), q(3, 'answered')], null)
    expect(scan.fresh).toEqual([])
    expect(scan.count).toBe(2)
    expect([...scan.ids]).toEqual([1, 2])
  })
  test('only ids absent from the previous set are fresh', () => {
    const scan = scanPending([q(1), q(2), q(3)], new Set([1, 2]))
    expect(scan.fresh.map(x => x.id)).toEqual([3])
    expect(scan.count).toBe(3)
  })
  test('answered or held questions are neither fresh nor counted', () => {
    const scan = scanPending([q(1, 'answered'), q(2, 'held')], new Set())
    expect(scan.fresh).toEqual([])
    expect(scan.count).toBe(0)
  })
  test('a question that was answered and returns to pending is fresh again', () => {
    const first = scanPending([q(1, 'answered')], new Set([1]))
    expect(scanPending([q(1)], first.ids).fresh.map(x => x.id)).toEqual([1])
  })
})

describe('text helpers', () => {
  test('firstLine skips blanks and truncates', () => {
    expect(firstLine('\n  hello\nworld')).toBe('hello')
    expect(firstLine('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(firstLine('')).toBe('')
  })
  test('badge is empty at zero', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(3)).toBe('3')
  })
  test('plan: none, single, many', () => {
    expect(planNotification([])).toBeNull()
    expect(planNotification([q(7, 'pending', 'first\nsecond')])).toEqual({ title: 'proj', body: 'first', questionId: 7 })
    expect(planNotification([q(1), q(2)])).toEqual({ many: 2 })
  })
})

test('a stall notifies once, and again only after the session moved', () => {
  const first = scanStalled(['a'], new Set())
  expect(first.fresh).toEqual(['a'])
  expect(scanStalled(['a'], first.ids).fresh).toEqual([])
  const moved = scanStalled([], first.ids)
  expect(scanStalled(['a'], moved.ids).fresh).toEqual(['a'])
})

test('a lifted limit notifies once', () => {
  const first = scanReleased(['a', 'b'], new Set())
  expect(first.released).toEqual([])
  const next = scanReleased(['b'], first.ids)
  expect(next.released).toEqual(['a'])
  expect(scanReleased(['b'], next.ids).released).toEqual([])
})
