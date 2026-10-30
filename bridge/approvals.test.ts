// Permission asks away from the desk (the mod's tool.check hook, mod/hooks/approval.ts): the
// hook waits with long polls, gives the ask up when it stops waiting, and an ask nobody waits
// for any more leaves the queue.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from './server.ts'

const dir = mkdtempSync(join(tmpdir(), 'sb-approvals-'))
const APP_KEY = 'a'.repeat(64)
const socketPath = join(dir, 'bridge.sock')
const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { appKey: APP_KEY })

type Got = { status: number; json: any }
function callAt(socket: string, method: string, path: string, body?: unknown): Promise<Got> & { abort: () => void } {
  let abort = () => undefined as void
  const promise = new Promise<Got>((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: { 'content-type': 'application/json', 'x-switchboard-app': APP_KEY } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    abort = () => req.destroy()
    req.on('error', error => (error.message.includes('socket hang up') ? undefined : reject(error)))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
  return Object.assign(promise, { abort: () => abort() })
}
const call = (method: string, path: string, body?: unknown) => callAt(socketPath, method, path, body)

async function ask(sessionId: string, key: string, socket = socketPath): Promise<number> {
  await callAt(socket, 'POST', '/sessions', { id: sessionId, cwd: `/w/${sessionId}` })
  return (await callAt(socket, 'POST', '/approvals', { sessionId, tool: 'Bash', summary: 'rm -rf build', requestKey: key })).json.id
}

before(() => listen(bridge.server, socketPath))
after(() => {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a long poll answers as soon as the person does, not when its wait ends', async () => {
  const id = await ask('lp-1', 'toolu_lp1')
  const started = Date.now()
  const poll = call('GET', `/approvals/${id}?wait=999999`)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await call('POST', `/approvals/${id}/answer`, { decision: 'allow' })).status, 200)
  const got = await poll
  assert.deepEqual(got.json, { id, status: 'allow', waitMs: 25_000 })
  assert.ok(Date.now() - started < 5000)
  // An answered ask answers at once, whatever the wait.
  assert.equal((await call('GET', `/approvals/${id}?wait=20000`)).json.status, 'allow')
})

test('an answer goes only with the call it was given for: the same key with another tool or summary is another ask', async () => {
  const id = await ask('dup-1', 'toolu_dup1')
  await call('POST', `/approvals/${id}/answer`, { decision: 'allow' })
  const post = (tool: string, summary: string) => call('POST', '/approvals', { sessionId: 'dup-1', tool, summary, requestKey: 'toolu_dup1' })
  assert.deepEqual((await post('Bash', 'rm -rf build')).json, { id, duplicate: true })
  const other = (await post('Bash', 'rm -rf ~')).json
  assert.notEqual(other.id, id)
  assert.equal(other.duplicate, undefined)
  assert.equal((await call('GET', `/approvals/${other.id}`)).json.status, 'pending')
  assert.notEqual((await post('Write', 'rm -rf build')).json.id, id)
})

test('a long poll with nothing to say answers pending when its wait ends; a poll the mod drops is let go', async () => {
  const id = await ask('lp-2', 'toolu_lp2')
  const started = Date.now()
  assert.deepEqual((await call('GET', `/approvals/${id}?wait=150`)).json, { id, status: 'pending', waitMs: 150 })
  assert.ok(Date.now() - started >= 140)
  // Without `wait` it answers at once, as for a mod from before long polls.
  assert.deepEqual((await call('GET', `/approvals/${id}`)).json, { id, status: 'pending', waitMs: 0 })
  const dropped = call('GET', `/approvals/${id}?wait=20000`)
  await new Promise(resolve => setTimeout(resolve, 50))
  dropped.abort()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await call('POST', `/approvals/${id}/answer`, { decision: 'deny' })).json.status, 'deny')
})

test('the mod gives an ask up when it stops waiting: it expires and a late answer is refused', async () => {
  const id = await ask('lp-3', 'toolu_lp3')
  assert.equal((await call('POST', `/approvals/${id}/abandon`, { sessionId: 'someone-else' })).status, 403)
  assert.deepEqual((await call('POST', `/approvals/${id}/abandon`, { sessionId: 'lp-3' })).json, { id, status: 'expired' })
  assert.equal((await call('POST', `/approvals/${id}/answer`, { decision: 'allow' })).status, 409)
  // Given up after an answer: the answer stands.
  const answered = await ask('lp-3', 'toolu_lp3b')
  await call('POST', `/approvals/${answered}/answer`, { decision: 'deny' })
  assert.equal((await call('POST', `/approvals/${answered}/abandon`, { sessionId: 'lp-3' })).json.status, 'deny')
  const events = (await call('GET', '/state')).json.events.map((e: { text: string }) => e.text)
  assert.ok(events.some((text: string) => text === `A${id} Bash 답을 기다리는 세션이 없어 만료`))
})

test('an ask nobody polls for 90 s expires, and one found at the start gets that long for its mod to come back', async t => {
  // The ask of a bridge that stopped while its mod waited.
  const before = mkdtempSync(join(tmpdir(), 'sb-approvals-'))
  const db = join(before, 'ide.db')
  const first = createBridge(db, 'ko-KR', { appKey: APP_KEY })
  await listen(first.server, join(before, 'a.sock'))
  const left = await ask('st-1', 'toolu_st1', join(before, 'a.sock'))
  first.close()

  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const second = createBridge(db, 'ko-KR', { appKey: APP_KEY })
  const socket = join(before, 'b.sock')
  await listen(second.server, socket)
  try {
    const polled = await ask('st-2', 'toolu_st2', socket)
    const status = async (id: number) => (await callAt(socket, 'GET', `/approvals/${id}`)).json.status
    t.mock.timers.tick(60_000)
    assert.equal((await callAt(socket, 'GET', '/state')).json.approvals.filter((a: { status: string }) => a.status === 'pending').length, 2)
    // The mod of st-2 is still there: it looks again (status() polls too).
    assert.equal(await status(polled), 'pending')
    t.mock.timers.tick(60_000)
    assert.equal(await status(left), 'expired')
    assert.equal(await status(polled), 'pending')
    t.mock.timers.tick(120_000)
    assert.equal(await status(polled), 'expired')
  } finally {
    second.close()
    rmSync(before, { recursive: true, force: true })
  }
})
