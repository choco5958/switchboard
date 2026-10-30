import { expect, test } from 'vitest'
import { currentSection } from './SettingsPage'

const tops: [string, number][] = [
  ['settings-telegram', 100],
  ['settings-mobile', 400],
  ['settings-agents', 900],
]

test('the section being read is the last one whose top has passed the line under the contents', () => {
  expect(currentSection(tops, 120, null)).toBe('settings-telegram')
  expect(currentSection(tops, 450, null)).toBe('settings-mobile')
  // Above the first section the first one is marked, not none.
  expect(currentSection(tops, 50, null)).toBe('settings-telegram')
})

test('not scrolled yet the first section is marked; at the bottom the last, however short', () => {
  expect(currentSection(tops, 450, 'top')).toBe('settings-telegram')
  expect(currentSection(tops, 450, 'bottom')).toBe('settings-agents')
  expect(currentSection([], 450, 'bottom')).toBeNull()
})
