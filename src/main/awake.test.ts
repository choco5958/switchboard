import { expect, it } from 'vitest'
import { AWAKE_MAX_MS, anyoneWorking } from './awake'

it('stays awake only for a connected session whose turn is working and not long silent', () => {
  const now = 10 * AWAKE_MAX_MS
  const working = { state: 'working' as const, openTools: 0, at: now - 1000 }
  expect(anyoneWorking({ a: working }, ['a'], now)).toBe(true)
  expect(anyoneWorking({ a: working }, [], now)).toBe(false)
  expect(anyoneWorking({ a: { ...working, state: 'idle' } }, ['a'], now)).toBe(false)
  expect(anyoneWorking({ a: { ...working, at: now - AWAKE_MAX_MS - 1 } }, ['a'], now)).toBe(false)
})
