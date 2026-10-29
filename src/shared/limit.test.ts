import { expect, test } from 'vitest'
import { RESET_GRACE_MS, UNKNOWN_RESET_MS, limitedUntil } from './limit'

const now = Date.parse('2026-10-29T05:00:00Z')
const usage = (rateLimits: unknown[], extra: object = {}) => JSON.stringify({ rateLimits, ...extra })

test('a window at 100% holds until its reset and 30 seconds more', () => {
  const reset = '2026-10-29T06:00:00Z'
  expect(limitedUntil(usage([{ kind: 'five_hour', percentUsed: 100, resetsAt: reset }]), now, now)).toBe(Date.parse(reset) + RESET_GRACE_MS)
  expect(limitedUntil(usage([{ kind: 'five_hour', percentUsed: 99, resetsAt: reset }]), now, now)).toBe(null)
})

test('the later of two full windows wins; a reset already past holds nothing', () => {
  const list = [
    { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-29T06:00:00Z' },
    { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-11-01T00:00:00Z' },
  ]
  expect(limitedUntil(usage(list), now, now)).toBe(Date.parse('2026-11-01T00:00:00Z') + RESET_GRACE_MS)
  expect(limitedUntil(usage([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-29T04:00:00Z' }]), now, now)).toBe(null)
})

test('a reset in epoch seconds, and none at all', () => {
  expect(limitedUntil(usage([{ kind: 'x', percentUsed: 100, resetsAt: now / 1000 + 60 }]), now, now)).toBe(now + 60_000 + RESET_GRACE_MS)
  expect(limitedUntil(usage([{ kind: 'x', percentUsed: 100 }]), now - 60_000, now)).toBe(now - 60_000 + UNKNOWN_RESET_MS)
})

test('ccr moves its sessions on by itself, and bad data holds nothing', () => {
  expect(limitedUntil(usage([{ kind: 'x', percentUsed: 100, resetsAt: '2026-10-29T06:00:00Z' }], { ccrSlot: 2 }), now, now)).toBe(null)
  expect(limitedUntil('not json', now, now)).toBe(null)
  expect(limitedUntil(undefined, now, now)).toBe(null)
})
