import { expect, test } from 'vitest'
import { consoleEntry, logText, maskSecrets, netEntry, pushEntry, type PageLogEntry } from './pageLog'

test('only warnings and errors from the console are kept, with where they came from', () => {
  expect(consoleEntry(1, 1, 'hello')).toBe(null)
  expect(consoleEntry(1, 'info', 'hello')).toBe(null)
  expect(consoleEntry(1, 3, 'TypeError: x is undefined', 'http://localhost:5173/src/App.tsx', 42)).toEqual({
    at: 1, kind: 'console', level: 'error', text: 'TypeError: x is undefined (App.tsx:42)',
  })
  expect(consoleEntry(1, 'warning', 'slow')?.level).toBe('warning')
})

test('a request counts when it failed, not when it was only cancelled', () => {
  expect(netEntry(1, { method: 'GET', url: '/a', statusCode: 200 })).toBe(null)
  expect(netEntry(1, { method: 'GET', url: '/a', error: 'net::ERR_ABORTED' })).toBe(null)
  expect(netEntry(1, { method: 'POST', url: '/api', statusCode: 404 })?.level).toBe('warning')
  expect(netEntry(1, { method: 'POST', url: '/api', statusCode: 502 })?.text).toBe('POST /api 502')
  expect(netEntry(1, { method: 'GET', url: '/b', error: 'net::ERR_CONNECTION_REFUSED' })?.level).toBe('error')
})

test('credentials are masked as they come in', () => {
  expect(maskSecrets('Authorization: Bearer abc.def.ghijkl')).toBe('Authorization: Bearer ***')
  expect(maskSecrets('GET /cb?code=1&access_token=s3cr3t&x=2')).toBe('GET /cb?code=1&access_token=***&x=2')
  expect(maskSecrets('key sk-ant-api03-abcdefghijklmnop')).toBe('key sk-***')
})

test('the list keeps the newest, and a comment carries the newest of each kind', () => {
  let list: PageLogEntry[] = []
  for (let i = 0; i < 5; i++) list = pushEntry(list, consoleEntry(i, 3, `e${i}`), 3)
  expect(list.map(e => e.text)).toEqual(['e2', 'e3', 'e4'])
  list = pushEntry(list, netEntry(10, { method: 'GET', url: '/x', statusCode: 500 }))
  const text = logText(list, 2)
  expect(text.split('\n')).toHaveLength(3)
  expect(text).toMatch(/console error: e3/)
  expect(text).not.toMatch(/e2/)
  expect(text).toMatch(/net error: GET \/x 500$/)
})
