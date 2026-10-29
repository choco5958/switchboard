import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRun, parseSchedule } from './schedule.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('daily runs at the time today when it is still ahead, else tomorrow', () => {
  assert.equal(nextRun({ kind: 'daily', time: '09:30' }, at(2026, 10, 29, 8)), at(2026, 10, 29, 9, 30))
  assert.equal(nextRun({ kind: 'daily', time: '09:30' }, at(2026, 10, 29, 9, 30)), at(2026, 10, 30, 9, 30))
})

test('weekdays skip Saturday and Sunday', () => {
  // 2026-10-30 is a Friday.
  assert.equal(nextRun({ kind: 'weekdays', time: '09:00' }, at(2026, 10, 30, 10)), at(2026, 11, 2, 9))
  assert.equal(nextRun({ kind: 'weekdays', time: '09:00' }, at(2026, 11, 1, 23)), at(2026, 11, 2, 9))
})

test('an interval counts from its anchor; a once passes', () => {
  const anchor = at(2026, 10, 29, 10)
  assert.equal(nextRun({ kind: 'interval', every: 30, anchor }, anchor - 1), anchor)
  assert.equal(nextRun({ kind: 'interval', every: 30, anchor }, anchor), anchor + 30 * 60_000)
  assert.equal(nextRun({ kind: 'interval', every: 30, anchor }, anchor + 45 * 60_000), anchor + 60 * 60_000)
  assert.equal(nextRun({ kind: 'once', at: '2026-10-29T15:00' }, at(2026, 10, 29, 14)), at(2026, 10, 29, 15))
  assert.equal(nextRun({ kind: 'once', at: '2026-10-29T15:00' }, at(2026, 10, 29, 15)), null)
})

test('what the app sends is checked', () => {
  const now = at(2026, 10, 29)
  assert.deepEqual(parseSchedule({ kind: 'daily', time: '7:05' }, now), { kind: 'daily', time: '7:05' })
  assert.ok('error' in parseSchedule({ kind: 'daily', time: '25:00' }, now))
  assert.ok('error' in parseSchedule({ kind: 'interval', every: 2 }, now))
  assert.deepEqual(parseSchedule({ kind: 'interval', every: 60 }, now), { kind: 'interval', every: 60, anchor: now })
  assert.ok('error' in parseSchedule({ kind: 'once', at: 'tomorrow' }, now))
  assert.ok('error' in parseSchedule({ kind: 'hourly' }, now))
})
