import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SLEEP_GAP_MS, sleepClock } from './asleep.ts'

test('a gap far longer than the looks is a sleep, and the wake is kept until the next one', () => {
  let clock = 1_000_000
  const sleeping = sleepClock(() => clock)
  clock += 10_000
  assert.equal(sleeping.check(), 0, 'looks as often as they come: never slept')
  clock += SLEEP_GAP_MS
  assert.equal(sleeping.check(), 0, 'a gap of exactly the limit is not yet a sleep')
  clock += 8 * 3600_000
  const woke = clock
  assert.equal(sleeping.check(), woke)
  clock += 10_000
  assert.equal(sleeping.check(), woke, 'later looks still say when it woke')
  clock += 2 * 3600_000
  assert.equal(sleeping.check(), clock, 'a second sleep moves it')
})
