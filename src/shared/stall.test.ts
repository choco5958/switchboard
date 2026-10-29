import { expect, test } from 'vitest'
import { STALL_MS, stalledSessions, type Activity } from './stall'

const now = 1_000_000_000

test('a working turn with no event and no open tool for five minutes is stalled', () => {
  const activity: Record<string, Activity> = {
    quiet: { state: 'working', openTools: 0, at: now - STALL_MS },
    recent: { state: 'working', openTools: 0, at: now - STALL_MS + 1000 },
    building: { state: 'working', openTools: 1, at: now - 3 * STALL_MS },
    idle: { state: 'idle', openTools: 0, at: now - 3 * STALL_MS },
    offline: { state: 'working', openTools: 0, at: now - 3 * STALL_MS },
  }
  expect(stalledSessions(activity, ['quiet', 'recent', 'building', 'idle'], now)).toEqual(['quiet'])
})
