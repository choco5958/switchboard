import { expect, test } from 'vitest'
import { FIRST_SECTION, SETTINGS_GROUPS, sectionMatches, sectionOf } from './SettingsPage'

const find = (id: string) => SETTINGS_GROUPS.flatMap(g => g.sections).find(s => s.id === id)!

test('a search finds a section by its title, its line or a row in it, every word', () => {
  expect(sectionMatches(find('settings-safety'), '')).toBe(true)
  expect(sectionMatches(find('settings-safety'), 'Codex')).toBe(true)
  expect(sectionMatches(find('settings-theme'), 'Codex')).toBe(false)
  expect(sectionMatches(find('settings-telegram'), 'telegram')).toBe(true)
})

test('a link names a section, or gets the first one', () => {
  expect(sectionOf('settings-update')).toBe('settings-update')
  expect(sectionOf('settings-nowhere')).toBe(FIRST_SECTION)
  expect(sectionOf(undefined)).toBe(FIRST_SECTION)
  // Every section id is unique, since links and the menu go by it.
  const ids = SETTINGS_GROUPS.flatMap(g => g.sections.map(s => s.id))
  expect(new Set(ids).size).toBe(ids.length)
})
