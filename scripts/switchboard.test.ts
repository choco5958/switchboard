import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
  // Fired already: the bridge is there and refuses, which is a failure, not 5.
  assert.equal((await cli(['fire', json.id])).code, EXIT.failed)
  assert.equal((await cli(['waits'])).out, 'no open waits')
  const items = (await call('POST', '/deliveries/take', { sessionId: 'c1' })).json.items as { text: string }[]
  assert.ok(items.some(item => /함께 온 내용:\n배포 완료/.test(item.text)))
})

// A call that answers each path from a table, one reply at a time; anything else is a 200 with nothing.
type Scripted = Record<string, { status: number; json: Record<string, unknown> }[]>
const scripted = (replies: Scripted) => async (_method: 'GET' | 'POST', path: string) => replies[path]?.shift() ?? { status: 200, json: {} }

async function runWith(argv: string[], call: Parameters<typeof run>[1]) {
  const out: string[] = []
  const err: string[] = []
  let clock = 0
  const code = await run(argv, call, {
    out: text => out.push(text),
    err: text => err.push(text),
    stdin: async () => '',
    sleep: async ms => void (clock += ms),
    now: () => clock,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('status: a bridge that refuses fails with 1, as JSON under --json, never a TypeError', async () => {
  const refused = (): Scripted => ({ '/messages/7': [{ status: 403, json: { error: 'forbidden' } }] })
  assert.deepEqual(await runWith(['status', 'm7'], scripted(refused())), { code: EXIT.failed, out: '', err: 'forbidden' })
  const asJson = await runWith(['status', 'm7', '--json'], scripted(refused()))
  assert.equal(asJson.code, EXIT.failed)
  assert.deepEqual(JSON.parse(asJson.out), { ok: false, exitCode: EXIT.failed, error: 'forbidden' })
  const broken = await runWith(['status', 'm7', '--json'], scripted({ '/messages/7': [{ status: 500, json: {} }] }))
  assert.deepEqual(JSON.parse(broken.out), { ok: false, exitCode: EXIT.failed, error: 'bridge answered 500' })
})

test('send --wait looks again after a 5xx and stops at any other refusal', async () => {
  const peers = () => [{ status: 200, json: { peers: [{ id: 's9', project: 'p9', cwd: '/p9', agent: 'claude', live: true, state: 'idle', task: '', now: '' }] } }]
  const sent = () => [{ status: 200, json: { id: 'm9' } }]
  const recovered = await runWith(
    ['send', 'p9', 'hi', '--wait'],
    scripted({
      '/sessions/peers': peers(),
      '/outbox': sent(),
      '/messages/9': [{ status: 503, json: {} }, { status: 200, json: { answered: true, reply: 'done', delivered: true, live: true, questions: [] } }],
    }),
  )
  assert.deepEqual([recovered.code, recovered.out], [EXIT.done, 'done'])
  const refused = await runWith(
    ['send', 'p9', 'hi', '--wait', '--json'],
    scripted({ '/sessions/peers': peers(), '/outbox': sent(), '/messages/9': [{ status: 400, json: { error: 'bad id' } }] }),
  )
  assert.equal(refused.code, EXIT.failed)
  assert.deepEqual(JSON.parse(refused.out), { ok: false, exitCode: EXIT.failed, error: 'bad id' })
})

test('fire: only a bridge out of reach is 5', async () => {
  assert.equal((await runWith(['fire', 'w3'], () => Promise.reject(new Error('ECONNREFUSED')))).code, EXIT.unreachable)
  assert.equal((await runWith(['fire', 'w3'], scripted({ '/waits/3/fire': [{ status: 404, json: { error: 'not found' } }] }))).code, EXIT.failed)
})

test('output past 64 KiB reaches a pipe whole', async () => {
  await call('POST', '/sessions', { id: 'big', cwd: '/w/big' })
  for (let i = 0; i < 300; i++) await call('POST', '/questions', { sessionId: 'big', question: `${i} ${'긴 질문 '.repeat(40)}`, options: [{ key: 'a', label: '예' }] })
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(
      process.execPath,
      [join(import.meta.dirname, 'switchboard.ts'), 'decisions', '--json'],
      { env: { ...process.env, CLAUDE_IDE_SOCKET: socketPath }, maxBuffer: 64 * 1024 * 1024 },
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  )
  assert.ok(stdout.length > 64 * 1024)
  assert.equal((JSON.parse(stdout) as { project: string }[]).filter(q => q.project === 'big').length, 300)
})
