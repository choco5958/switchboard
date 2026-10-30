import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath the mod, as far as a session's start and end reach: a store in memory
// whose deletions the test reads, and a bridge the mod never manages to start.
function world(on: On) {
  const store = new Map<string, unknown>([
    ['sent:s1', ['q1']],
    ['commands:s1', [3]],
    ['agents:s1', { paused: [], stopped: [] }],
    ['queued:s1', []],
  ])
  const deleted: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    deleted.push(e.key)
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'printenv' ? 0 : 1,
      stdout: e.argv[0] === 'printenv' ? '/home/t\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', () => {
    throw new Error('ECONNREFUSED')
  })
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  return { store, deleted }
}

const KEYS = ['sent:s1', 'commands:s1', 'agents:s1', 'queued:s1']

test('a /clear or a resume keeps the session\'s store keys, which the mod goes on using', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const reason of ['clear', 'resume'] as const) await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
  expect(w.deleted.filter(key => KEYS.includes(key))).toEqual([])
  expect(w.store.get('sent:s1')).toEqual(['q1'])
})

test('an exit removes them', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(w.deleted.filter(key => KEYS.includes(key)).sort()).toEqual([...KEYS].sort())
})
