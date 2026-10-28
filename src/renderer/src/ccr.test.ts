import { describe, expect, test } from 'vitest'
import { ccrFree, ccrTitle } from './TopBar'
import type { CcrSlot } from '../../shared/types'

const NOW = 1_793_000_000_000
const slot = (over: Partial<CcrSlot>): CcrSlot => ({ slot: 1, email: 'on****@x.kr', plan: '', until: 0, ...over })

describe('ccr top bar', () => {
  test('a slot is free when signed in and its limit has lifted', () => {
    expect(ccrFree(slot({}), NOW)).toBe(true)
    expect(ccrFree(slot({ until: NOW / 1000 + 600 }), NOW)).toBe(false)
    expect(ccrFree(slot({ until: NOW / 1000 - 1 }), NOW)).toBe(true)
    expect(ccrFree(slot({ email: '' }), NOW)).toBe(false)
  })
  test('the title marks the current slot and shows limits and usage', () => {
    const title = ccrTitle(
      { current: 2, slots: [slot({ until: NOW / 1000 + 3600 }), slot({ slot: 2, fiveHour: 21, week: 100 }), slot({ slot: 3, email: '' })] },
      NOW,
    ).split('\n')
    expect(title).toHaveLength(4)
    expect(title[1]).toMatch(/^ {2}1\D.*-.*-/)
    expect(title[1]!.split(', ')).toHaveLength(4) // the slot still under its limit says so
    expect(title[2]!.split(', ')).toHaveLength(3)
    expect(title[2]).toMatch(/^▶ 2\D.*21%.*100%/)
    expect(title[3]).toMatch(/^ {2}3\D/)
  })
})
