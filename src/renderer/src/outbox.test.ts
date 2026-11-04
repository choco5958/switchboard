import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { draftOf, flushAll, isWaiting, queueAnswer, subscribe, takeBack, waitingIds } from './outbox'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  flushAll()
  vi.useRealTimers()
})

test('an answer goes only once the delay is over', () => {
  const send = vi.fn(async () => true)
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
  const send = vi.fn(async () => true)
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
  const first = vi.fn(async () => true)
  const second = vi.fn(async () => true)
  queueAnswer(3, { choice: 'a', memo: '' }, first, 5000)
  queueAnswer(3, { choice: 'b', memo: '' }, second, 5000)
  vi.advanceTimersByTime(5000)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
})

test('an answer the bridge did not take comes back to its card; one it took does not', async () => {
  const heard = vi.fn()
  const off = subscribe(heard)
  queueAnswer(10, { choice: 'a', memo: '다시 보낼 메모' }, async () => false, 5000)
  queueAnswer(11, { choice: 'b', memo: '' }, async () => Promise.reject(new Error('ipc')), 5000)
  queueAnswer(12, { choice: 'c', memo: '' }, async () => true, 5000)
  await vi.advanceTimersByTimeAsync(5000)
  expect(draftOf(10)).toEqual({ choice: 'a', memo: '다시 보낼 메모' })
  expect(draftOf(11)).toEqual({ choice: 'b', memo: '' })
  expect(draftOf(12)).toBeUndefined()
  // Three queued, three gone, and the card hears that two drafts came back.
  expect(heard).toHaveBeenCalledTimes(3 + 3 + 2)
  off()
  // Sending it again starts clean.
  queueAnswer(10, { choice: 'a', memo: '다시 보낼 메모' }, async () => true, 5000)
  expect(draftOf(10)).toBeUndefined()
})

test('a failed send does not bring back an answer that replaced it meanwhile', async () => {
  let fail: (took: boolean) => void = () => undefined
  queueAnswer(13, { choice: 'a', memo: '' }, () => new Promise<boolean>(resolve => (fail = resolve)), 5000)
  await vi.advanceTimersByTimeAsync(5000)
  queueAnswer(13, { choice: 'b', memo: '' }, async () => true, 5000)
  fail(false)
  await Promise.resolve()
  expect(draftOf(13)).toBeUndefined()
  expect(isWaiting(13)).toBe(true)
})

test('closing the window sends what still waits, and listeners hear each change', () => {
  const send = vi.fn(async () => true)
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

test('an answer the app never got to send goes at the next start, and only once', async () => {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  })
  try {
    vi.resetModules()
    const before = await import('./outbox')
    before.queueAnswer(7, { choice: 'a', memo: '메모' }, async () => true, 5000)
    before.queueAnswer(8, { choice: 'b', memo: '' }, async () => true, 5000)
    before.takeBack(8)
    // The app is gone before the wait is over: a fresh module, as at the next start.
    vi.resetModules()
    const after = await import('./outbox')
    const post = vi.fn(async () => true)
    await after.resendLeft(post)
    expect(post.mock.calls).toEqual([[7, { choice: 'a', memo: '메모' }]])
    await after.resendLeft(post)
    expect(post).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('an answer the bridge could not take yet stays for the next start', async () => {
  const mem = new Map<string, string>([['switchboard.outbox', JSON.stringify({ 9: { choice: 'c', memo: '' } })]])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  })
  try {
    vi.resetModules()
    const { resendLeft } = await import('./outbox')
    await resendLeft(async () => false)
    const post = vi.fn(async () => true)
    await resendLeft(post)
    expect(post).toHaveBeenCalledWith(9, { choice: 'c', memo: '' })
  } finally {
    vi.unstubAllGlobals()
  }
})
