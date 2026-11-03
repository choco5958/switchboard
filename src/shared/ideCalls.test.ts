import { expect, test } from 'vitest'
import type { IdeApi } from './types'
import { IDE_CALLS, buildApi, decodeArgs, encodeArgs } from './ideCalls'

// Every window.ide method has its row, and no row names a method the page does not have.
type Missing = Exclude<keyof IdeApi, keyof typeof IDE_CALLS>
type Extra = Exclude<keyof typeof IDE_CALLS, keyof IdeApi>
const none: [Missing, Extra] extends [never, never] ? true : false = true

test('the table covers window.ide exactly', () => {
  expect(none).toBe(true)
})

test('an API from the table reaches the shell on each row channel, with the arguments it maps', async () => {
  const seen: { how: string; channel: string; args: unknown[] }[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = buildApi(IDE_CALLS, {
    invoke: async (channel, args) => (seen.push({ how: 'invoke', channel, args }), 'answer'),
    send: (channel, args) => void seen.push({ how: 'send', channel, args }),
    listen: (channel, listener) => (listeners.set(channel, listener), () => listeners.delete(channel)),
  }) as unknown as IdeApi

  expect(await api.answer(3, 'a', 'memo')).toBe('answer')
  await api.commandResult(7)
  await api.detectAgents()
  api.termWrite('t1', 'ls\r')
  const got: unknown[] = []
  const off = api.onTermData(event => got.push(event))
  listeners.get('term:data')!({ id: 't1', data: 'x', seq: 1 })
  off()

  expect(seen).toEqual([
    { how: 'invoke', channel: 'bridge:answer', args: [3, 'a', 'memo'] },
    { how: 'invoke', channel: 'bridge:call', args: ['GET', '/commands/7'] },
    { how: 'invoke', channel: 'agents:detect', args: [false] },
    { how: 'send', channel: 'term:write', args: ['t1', 'ls\r'] },
  ])
  expect(got).toEqual([{ id: 't1', data: 'x', seq: 1 }])
  expect(listeners.has('term:data')).toBe(false)
})

test('undefined arguments survive JSON, and nothing else turns into undefined', () => {
  const args = [undefined, null, 0, '', { $undefined: true, other: 1 }, ['x']]
  expect(decodeArgs(JSON.parse(JSON.stringify(encodeArgs(args))))).toEqual(args)
})
