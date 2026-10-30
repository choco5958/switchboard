import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DICTS } from '../../shared/i18n'
import { isHelpKey, isPaletteKey, shortcutGroups } from './shortcuts'

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra })
// A stand-in for an element: closest() answers as the real one would for these selectors.
const field = { closest: (selector: string) => (selector.includes('input') ? {} : null) } as unknown as EventTarget
const button = { closest: () => null } as unknown as EventTarget

describe('the keys the app listens for', () => {
  test('⌘K and Ctrl+K open the palette', () => {
    expect(isPaletteKey(key('k', { metaKey: true }))).toBe(true)
    expect(isPaletteKey(key('K', { ctrlKey: true }))).toBe(true)
    expect(isPaletteKey(key('k'))).toBe(false)
  })

  test('? opens the help outside a text field, ⌘/ and Ctrl+/ anywhere', () => {
    expect(isHelpKey(key('?', { target: button }))).toBe(true)
    expect(isHelpKey(key('?', { target: field }))).toBe(false)
    expect(isHelpKey(key('/', { metaKey: true, target: field }))).toBe(true)
    expect(isHelpKey(key('/', { ctrlKey: true }))).toBe(true)
    expect(isHelpKey(key('/'))).toBe(false)
  })
})

describe('the help list', () => {
  const dir = import.meta.dirname
  for (const mac of [true, false])
    test(`every listed shortcut still has its handler (${mac ? 'Mac' : 'other'})`, () => {
      for (const group of shortcutGroups(mac, false))
        for (const item of group.items) expect(readFileSync(join(dir, item.source), 'utf8'), `${item.label} in ${item.source}`).toContain(item.needle)
    })

  test('every label has a string in every language', () => {
    const keys = shortcutGroups(true, true).flatMap(g => [g.title, ...(g.note ? [g.note] : []), ...g.items.map(i => i.label)])
    for (const dict of Object.values(DICTS)) for (const k of keys) expect(dict[k], k).toBeTruthy()
  })

  test('the keys are written for the system', () => {
    const first = (mac: boolean) => shortcutGroups(mac, false)[0]!.items[0]!.keys[0]
    expect(first(true)).toBe('⌘K')
    expect(first(false)).toBe('Ctrl+K')
  })
})
