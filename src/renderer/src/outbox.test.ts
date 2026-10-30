import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { draftOf, flushAll, isWaiting, queueAnswer, subscribe, takeBack, waitingIds } from './outbox'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  flushAll()
  vi.useRealTimers()
})

test('an answer goes only once the delay is over', () => {
  const send = vi.fn(async () => undefined)
  queueAnswer(1, { choice: 'a', memo: '' }, send, 5000)
  expect(isWaiting(1)).toBe(true)
  vi.advanceTimersByTime(4999)
  expect(send).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(send).toHaveBeenCalledTimes(1)
  expect(isWaiting(1)).toBe(false)
  // Gone: there is nothing left to take back.
  expect(takeBack(1)).toBeNull()
})

test('undo keeps the answer in the app and hands back what was picked', () => {
  const send = vi.fn(async () => undefined)
  queueAnswer(2, { choice: 'b', memo: '메모' }, send, 5000)
  expect(takeBack(2)).toEqual({ choice: 'b', memo: '메모' })
  vi.advanceTimersByTime(10_000)
  expect(send).not.toHaveBeenCalled()
  expect(draftOf(2)).toEqual({ choice: 'b', memo: '메모' })
  // Answering again starts clean.
  queueAnswer(2, { choice: 'a', memo: '' }, send, 5000)
  expect(draftOf(2)).toBeUndefined()
})

test('a second answer to the same question replaces the first', () => {
  const first = vi.fn(async () => undefined)
  const second = vi.fn(async () => undefined)
  queueAnswer(3, { choice: 'a', memo: '' }, first, 5000)
  queueAnswer(3, { choice: 'b', memo: '' }, second, 5000)
  vi.advanceTimersByTime(5000)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
})

test('closing the window sends what still waits, and listeners hear each change', () => {
  const send = vi.fn(async () => undefined)
  const heard = vi.fn()
  const off = subscribe(heard)
  queueAnswer(4, { choice: 'a', memo: '' }, send, 5000)
  queueAnswer(5, { choice: 'b', memo: '' }, send, 5000)
  expect(waitingIds()).toEqual(new Set([4, 5]))
  flushAll()
  expect(send).toHaveBeenCalledTimes(2)
  expect(waitingIds()).toEqual(new Set())
  expect(heard).toHaveBeenCalledTimes(3)
  off()
})
