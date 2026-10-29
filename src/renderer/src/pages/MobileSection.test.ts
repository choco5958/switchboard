import { expect, test } from 'vitest'
import { pairLink } from './MobileSection'

test('the pairing link keeps the key in the fragment, which the browser never sends', () => {
  const link = new URL(pairLink('http://192.168.0.5:47390', 3, 'k3y-_abc'))
  expect(link.origin).toBe('http://192.168.0.5:47390')
  expect(link.pathname + link.search).toBe('/')
  expect(link.hash).toBe('#pair=3.k3y-_abc')
  expect(pairLink('https://mac.tail1.ts.net', 3, 'k')).toBe('https://mac.tail1.ts.net/#pair=3.k')
})
