import { describe, expect, test } from 'vitest'
import { matches } from './Palette'

describe('the search palette', () => {
  const item = { group: 'Sessions', label: 'shop', hint: 'Fix the Checkout page' }

  test('every word must be in the group, the label or the hint, ignoring case', () => {
    expect(matches('', item)).toBe(true)
    expect(matches('CHECKOUT shop', item)).toBe(true)
    expect(matches('sessions', item)).toBe(true)
    expect(matches('shop blog', item)).toBe(false)
  })

  test('a Korean folder name kept in separate jamo (a folder made in Finder) matches typed text, and the other way round', () => {
    const typed = '가계부'
    const onDisk = typed.normalize('NFD')
    expect(onDisk).not.toBe(typed)
    expect(matches(typed, { group: 'Projects', label: onDisk })).toBe(true)
    expect(matches(onDisk, { group: 'Projects', label: typed })).toBe(true)
    expect(matches('가게', { group: 'Projects', label: onDisk })).toBe(false)
  })
})
