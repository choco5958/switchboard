import { describe, expect, test } from 'vitest'
import { ccrFree, slotTitle, slotToken, slotUsage } from './TopBar'
import type { CcrSlot, Session } from '../../shared/types'

const NOW = 1_793_000_000_000
const slot = (over: Partial<CcrSlot>): CcrSlot => ({ slot: 1, email: 'on****@x.kr', plan: '', until: 0, ...over })
const session = (usage: object, lastSeen = NOW - 60_000, agent = 'claude') =>
  ({ id: 's', cwd: '/x', started_at: 0, last_seen: lastSeen, usage: JSON.stringify(usage), agent }) as unknown as Session

describe('ccr top bar', () => {
  test('a slot is free when signed in and its limit has lifted', () => {
    expect(ccrFree(slot({}), NOW)).toBe(true)
    expect(ccrFree(slot({ until: NOW / 1000 + 600 }), NOW)).toBe(false)
    expect(ccrFree(slot({ until: NOW / 1000 - 1 }), NOW)).toBe(true)
    expect(ccrFree(slot({ email: '' }), NOW)).toBe(false)
    expect(ccrFree(slot({ email: '', token: true }), NOW)).toBe(true)
  })

  test('a running session on the slot beats what ccr measured', () => {
    const limits = [{ kind: 'five_hour', percentUsed: 33 }, { kind: 'seven_day', percentUsed: 61 }]
    const two = slot({ slot: 2, fiveHour: 5, week: 10 })
    expect(slotUsage(two, [session({ ccrSlot: 2, rateLimits: limits })], NOW)).toEqual({ five: 33, week: 61, live: true })
    // another slot's session, a stale one, or one with no limits: fall back to ccr's numbers
    expect(slotUsage(two, [session({ ccrSlot: 3, rateLimits: limits })], NOW)).toEqual({ five: 5, week: 10, live: false })
    expect(slotUsage(two, [session({ ccrSlot: 2, rateLimits: limits }, NOW - 20 * 60_000)], NOW).live).toBe(false)
    expect(slotUsage(two, [session({ ccrSlot: 2 })], NOW).live).toBe(false)
  })

  test('the slot tooltip says whose numbers they are, the limit and a failed measurement', () => {
    const spent = slotTitle(slot({ until: NOW / 1000 + 3600, measuredAt: NOW / 1000 - 60, measureError: 'http 401' }), true, { five: 20, week: 100, live: false }, NOW).split('\n')
    expect(spent).toHaveLength(6)
    expect(spent[5]).toContain('http 401')
    const live = slotTitle(slot({ slot: 3 }), false, { five: 1, live: true }, NOW).split('\n')
    expect(live).toHaveLength(3)
    expect(live[1]).toMatch(/1%.*-/)
  })
})

describe('ccr slot token', () => {
  const day = 86400_000

  test('a year token wins over the refresh expiry', () => {
    expect(slotToken(slot({ token: true, refreshExpiresAt: NOW + day }), NOW)).toEqual({ kind: 'year' })
  })

  test('without one, days left warn at three or fewer', () => {
    expect(slotToken(slot({ refreshExpiresAt: NOW + 10 * day }), NOW)).toEqual({ kind: 'days', days: 10, warn: false })
    expect(slotToken(slot({ refreshExpiresAt: NOW + 3 * day }), NOW)).toEqual({ kind: 'days', days: 3, warn: true })
    expect(slotToken(slot({ refreshExpiresAt: NOW + 1.4 * day }), NOW)).toEqual({ kind: 'days', days: 1, warn: true })
    expect(slotToken(slot({ refreshExpiresAt: NOW - 1 }), NOW)).toEqual({ kind: 'expired' })
  })

  test('nothing to show for a signed out slot or an unmeasured one', () => {
    expect(slotToken(slot({ email: '', refreshExpiresAt: NOW + day }), NOW)).toEqual({ kind: 'none' })
    expect(slotToken(slot({}), NOW)).toEqual({ kind: 'none' })
  })

  test('the tooltip gains one line for the token state', () => {
    expect(slotTitle(slot({ token: true }), false, { live: false }, NOW).split('\n').length).toBe(4)
    expect(slotTitle(slot({ refreshExpiresAt: NOW + 2 * day }), false, { live: false }, NOW)).toContain('2')
  })
})
