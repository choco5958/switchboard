import { expect, test } from 'vitest'
import { composing } from './ime'

test('an Enter that commits a composed syllable counts as composing', () => {
  expect(composing({ isComposing: true, keyCode: 13 })).toBe(true)
  expect(composing({ nativeEvent: { isComposing: true } })).toBe(true)
  expect(composing({ keyCode: 229 })).toBe(true)
})

test('a plain Enter does not', () => {
  expect(composing({ isComposing: false, keyCode: 13 })).toBe(false)
  expect(composing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false)
  expect(composing({})).toBe(false)
})
