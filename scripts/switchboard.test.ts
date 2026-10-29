import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from '../bridge/server.ts'
import { EXIT, duration, parseArgs, resolveSession, run } from './switchboard.ts'

const dir = mkdtempSync(join(tmpdir(), 'sb-cli-'))
const socketPath = join(dir, 'b.sock')
const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { appKey: 'a'.repeat(64) })

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', 'x-switchboard-app': 'a'.repeat(64) } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

// The CLI against the test bridge, with a clock the test moves and a hook that runs on each wait.
async function cli(argv: string[], onSleep: () => Promise<void> = async () => undefined) {
  const out: string[] = []
  const err: string[] = []
  let clock = 0
  const code = await run(argv, call, {
    out: text => out.push(text),
    err: text => err.push(text),
    stdin: async () => '표준 입력의 작업',
    sleep: async ms => {
      clock += ms
      await onSleep()
    },
    now: () => clock,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

before(async () => {
  await listen(bridge.server, socketPath)
  await call('POST', '/sessions', { id: 'c1', cwd: '/w/web' })
  await call('POST', '/sessions', { id: 'c2', cwd: '/w/api', project: 'api' })
  await call('POST', '/sessions', { id: 'c3', cwd: '/x/api', project: 'api' })
})
after(() => {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

test('arguments, durations and which session a name means', () => {
  assert.deepEqual(parseArgs(['send', 'web', 'a', 'b', '--wait', '--timeout', '5m']), { command: 'send', args: ['web', 'a', 'b'], flags: { wait: true, timeout: '5m' } })
  assert.equal(duration('90s'), 90_000)
  assert.equal(duration('2h'), 7_200_000)
  assert.equal(duration('10'), 10_000)
  assert.equal(duration('soon'), null)
  const peers = [
    { id: 's1', project: 'web', live: true },
    { id: 's2', project: 'web', live: false },
    { id: 's3', project: 'api', live: true },
    { id: 's4', project: 'api', live: true },
  ].map(p => ({ cwd: '', agent: 'claude', state: '', task: '', now: '', ...p }))
  assert.deepEqual(resolveSession(peers, 's2'), { id: 's2' })
  assert.deepEqual(resolveSession(peers, 'web'), { id: 's1' })
  assert.deepEqual(resolveSession(peers, 'api'), { error: 'many', ids: ['s3', 's4'] })
  assert.deepEqual(resolveSession(peers, 'docs'), { error: 'none', ids: [] })
})

test('send --wait prints the reply the session gave at the end of its turn', async () => {
  const result = await cli(['send', 'web', '테스트', '돌려줘', '--wait'], async () => {
    const taken = await call('POST', '/deliveries/take', { sessionId: 'c1' })
    for (const item of taken.json.items as { id: string; text: string }[]) {
      assert.match(item.text, /셸\(switchboard 명령\)에서 보낸 요청/)
      assert.match(item.text, /--- 메시지 ---\n테스트 돌려줘$/)
      await call('POST', '/messages/turn-end', { sessionId: 'c1', ids: [item.id], answer: '상태: 완료\n결과: 통과 12' })
    }
  })
  assert.equal(result.code, EXIT.done)
  assert.equal(result.out, '상태: 완료\n결과: 통과 12')
})

test('a decision the session posts while working ends the wait with 3', async () => {
  const result = await cli(['send', 'web', '-', '--wait', '--json'], async () => {
    await call('POST', '/questions', { sessionId: 'c1', question: '어느 DB로 할까', options: [{ key: 'a', label: 'pg' }] })
  })
  assert.equal(result.code, EXIT.person)
  assert.equal(JSON.parse(result.out).questions[0].question, '어느 DB로 할까')
  const open = await cli(['decisions'])
  assert.match(open.out, /Q\d+ \[web\] 어느 DB로 할까\n {4}\(a\) pg/)
  const id = /Q(\d+)/.exec(open.out)![1]
  assert.equal((await cli(['answer', `Q${id}`, 'a', '가까운', '쪽'])).code, EXIT.done)
  assert.doesNotMatch((await cli(['decisions'])).out, /어느 DB로 할까/)
  await call('POST', '/deliveries/take', { sessionId: 'c1' })
})

test('the wait gives up at the timeout and the message stays to look at later', async () => {
  const result = await cli(['send', 'c2', '긴 작업', '--wait', '--timeout', '4s'])
  assert.equal(result.code, EXIT.timeout)
  const id = /m\d+/.exec(result.err)![0]
  assert.equal((await cli(['status', id])).out, 'waiting for the session to connect')
})

test('a name two sessions share, an unknown one, a bad command line', async () => {
  assert.equal((await cli(['send', 'api', 'x'])).code, EXIT.usage)
  assert.equal((await cli(['send', 'nowhere', 'x'])).code, EXIT.unreachable)
  assert.equal((await cli(['send', 'web'])).code, EXIT.usage)
  assert.equal((await cli(['dance'])).code, EXIT.usage)
  const plain = await cli(['send', 'web', '알림만', '--info'])
  assert.equal(plain.code, EXIT.done)
  assert.match(plain.out, /^m\d+$/)
})

test('no bridge: 5', async () => {
  const code = await run(['sessions'], () => Promise.reject(new Error('ENOENT')), {
    out: () => undefined,
    err: () => undefined,
    stdin: async () => '',
    sleep: async () => undefined,
    now: () => 0,
  })
  assert.equal(code, EXIT.unreachable)
})

test('fire puts the wait back into its session; waits lists the open ones', async () => {
  const { json } = await call('POST', '/waits', { sessionId: 'c1', note: '배포 끝나면 스모크 테스트' })
  assert.match((await cli(['waits'])).out, new RegExp(`${json.id} \\[web\\] 배포 끝나면 스모크 테스트`))
  assert.equal((await cli(['fire', json.id, '배포', '완료'])).code, EXIT.done)
  assert.equal((await cli(['fire', json.id])).code, EXIT.unreachable)
  assert.equal((await cli(['waits'])).out, 'no open waits')
  const items = (await call('POST', '/deliveries/take', { sessionId: 'c1' })).json.items as { text: string }[]
  assert.ok(items.some(item => /함께 온 내용:\n배포 완료/.test(item.text)))
})
