import { afterEach, expect, test } from 'vitest'
import { THEMES, themeLabel } from './theme'
import { setLang } from '../../shared/i18n'
import { ko } from '../../shared/i18n/ko'

afterEach(() => setLang('ko'))

test('theme names follow the UI language, and the Korean key matches the label in THEMES', () => {
  for (const theme of THEMES) {
    const key = `theme.${theme.id}` as keyof typeof ko
    if (key in ko) expect(ko[key]).toBe(theme.label)
    expect(themeLabel(theme)).toBe(theme.label)
  }
  setLang('en')
  expect(themeLabel({ id: 'metro', label: '지하철 노선도' })).toBe('Subway map')
})

test('a theme without a dictionary key shows its own label', () => {
  setLang('ja')
  expect(themeLabel({ id: 'brand-new', label: '새 테마' })).toBe('새 테마')
})
