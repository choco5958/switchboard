import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridge, listen } from '../../bridge/server.ts'
import type { Reply, Session } from '../shared/types'
import { PASTE_END, PASTE_START, QUIET_MS, type TypingTarget } from './agentInput'
import { startAgentDelivery, typePrompt, typedSessions } from './agentDelivery'

const dir = mkdtempSync(join(tmpdir(), 'sb-deliv-'))
const socketPath = join(dir, 'bridge.sock')
const bridge = createBridge(join(dir, 'ide.db'))

function call(method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise(resolve => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', error => resolve({ ok: false, status: 0, json: { error: error.message } }))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

beforeAll(async () => {
  await listen(bridge.server, socketPath)
  await call('POST', '/settings', { key: 'lang', value: 'ko' })
})
afterAll(() => {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

function fakeTerminal(over: Partial<TypingTarget> = {}) {
  const written: string[] = []
  const target: TypingTarget = { alive: true, shell: '/bin/zsh', foreground: 'node', lastOutput: 0, paste: true, write: d => written.push(d), ...over }
  return { target, written }
}

describe('typing for agent CLIs in app terminals', () => {
  it('a prompt is the paste first, and Enter on its own afterwards', () => {
    const { target, written } = fakeTerminal()
    const later: (() => void)[] = []
    expect(typePrompt(target, '두 줄\n답', fn => later.push(fn))).toBe(true)
    expect(written).toEqual([`${PASTE_START}두 줄\n답${PASTE_END}`])
    later[0]!()
    expect(written.at(-1)).toBe('\r')
    expect(typePrompt(target, '  ')).toBe(false)
  })

  it('types only for non-Claude sessions whose terminal is open here', () => {
    const open = fakeTerminal().target
    const sessions = [
      { id: 'a', agent: 'codex', terminal: 'k-t1' },
      { id: 'b', agent: 'claude', terminal: 'k-t1' },
      { id: 'c', agent: 'gemini', terminal: '' },
      { id: 'd', agent: 'gemini', terminal: 'k-t9' },
    ] as Session[]
    expect(typedSessions(sessions, key => (key === 'k-t1' ? open : undefined)).map(s => s.id)).toEqual(['a'])
  })

  it('an answer given in the app is typed into the terminal once, and marked delivered', async () => {
    await call('POST', '/sessions', { id: 'cx-live', cwd: '/work/app', agent: 'codex', terminal: 'k-t1' })
    const { target, written } = fakeTerminal()
    let clock = QUIET_MS * 10
    const delivery = startAgentDelivery({ socketPath, call, terminal: key => (key === 'k-t1' ? target : undefined), now: () => clock, lang: () => 'ko' })
    await delivery.refresh()
    expect(delivery.sessions()).toEqual(['cx-live'])
    await new Promise(resolve => setTimeout(resolve, 50))

    const { json: q } = await call('POST', '/questions', { sessionId: 'cx-live', question: '배포할까', options: [{ key: 'a', label: '예' }] })
    // Busy: the CLI drew something a moment ago, so nothing is typed yet.
    target.lastOutput = clock
    await call('POST', `/questions/${q.id}/answer`, { choice: 'a' })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(written).toEqual([])
    clock += QUIET_MS
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(written[0]).toContain(`[Switchboard] Q${q.id} 답이 왔습니다.`)
    expect(written[0]!.startsWith(PASTE_START)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(written).toHaveLength(2)
    expect(written[1]).toBe('\r')
    const row = (await call('GET', '/state')).json.questions as { id: number; delivered: number }[]
    expect(row.find(r => r.id === q.id)?.delivered).toBe(1)
    delivery.stop()
  })
})
