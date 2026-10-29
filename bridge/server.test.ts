import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, deliveryText, listen, nodeEventText, projectName } from './server.ts'

const dir = mkdtempSync(join(tmpdir(), 'claude-ide-'))
const socketPath = join(dir, 'bridge.sock')
const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR')

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

// Every frame of one kind a delivery stream sends until `count` arrived.
function frames(sessionId: string, event: string, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/deliveries?session=${sessionId}` }, res => {
      let buffer = ''
      res.on('data', chunk => {
        buffer += chunk
        const got = [...buffer.matchAll(new RegExp(`event: ${event}\ndata: (.*)\n\n`, 'g'))].map(m => JSON.parse(m[1] ?? '{}'))
        if (got.length >= count) {
          resolve(got)
          req.destroy()
        }
      })
    })
    req.on('error', error => (error.message.includes('aborted') ? undefined : reject(error)))
    req.end()
  })
}

function firstDelivery(sessionId: string): Promise<{ id: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/deliveries?session=${sessionId}` }, res => {
      let buffer = ''
      res.on('data', chunk => {
        buffer += chunk
        const match = buffer.match(/event: delivery\ndata: (.*)\n\n/)
        if (match) {
          resolve(JSON.parse(match[1] ?? '{}'))
          req.destroy()
        }
      })
    })
    req.on('error', error => (error.message.includes('aborted') ? undefined : reject(error)))
    req.end()
  })
}

before(() => listen(bridge.server, socketPath))
after(() => {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a session registers under its folder name', async () => {
  const { json } = await call('POST', '/sessions', { id: 's1', cwd: '/work/music-app' })
  assert.equal(json.project, 'music-app')
})

test('a session is live while its delivery stream is open', async () => {
  await call('POST', '/sessions', { id: 'live-1', cwd: '/work/live' })
  assert.ok(!(await call('GET', '/state')).json.live.includes('live-1'))
  const req = request({ socketPath, path: '/deliveries?session=live-1' })
  req.on('error', () => undefined)
  req.end()
  await new Promise(resolve => req.on('response', resolve))
  assert.ok((await call('GET', '/state')).json.live.includes('live-1'))
  req.destroy()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(!(await call('GET', '/state')).json.live.includes('live-1'))
})

test('the same question is posted once: by its call id, or while the first still waits', async () => {
  await call('POST', '/sessions', { id: 'dup-1', cwd: '/work/dup' })
  const ask = (extra: object) =>
    call('POST', '/questions', { sessionId: 'dup-1', question: '캐시를 지울까', options: [{ key: 'a', label: '예' }], ...extra })
  const first = (await ask({ requestKey: 'toolu_1' })).json
  assert.equal(first.duplicate, undefined)
  assert.deepEqual((await ask({ requestKey: 'toolu_1' })).json, { id: first.id, duplicate: true })
  assert.deepEqual((await ask({ requestKey: 'toolu_2' })).json, { id: first.id, duplicate: true })
  const other = (await ask({ options: [{ key: 'b', label: '아니오' }] })).json
  assert.notEqual(other.id, first.id)
  await call('POST', `/questions/${first.id}/answer`, { choice: 'a' })
  assert.deepEqual((await ask({ requestKey: 'toolu_1' })).json, { id: first.id, duplicate: true })
  assert.notEqual((await ask({ requestKey: 'toolu_3' })).json.id, first.id)
})

test('a session reports what its turn is doing', async () => {
  assert.equal((await call('POST', '/sessions/activity', { sessionId: 's1', state: 'busy' })).status, 400)
  await call('POST', '/sessions/activity', { sessionId: 's1', state: 'working', openTools: 2 })
  const { json } = await call('GET', '/state')
  assert.equal(json.activity.s1.state, 'working')
  assert.equal(json.activity.s1.openTools, 2)
  assert.equal(typeof json.activity.s1.at, 'number')
  await call('POST', '/sessions/activity', { sessionId: 's1', state: 'idle', openTools: 0 })
  assert.equal((await call('GET', '/state')).json.activity.s1.state, 'idle')
})

test('a task upserts by title and keeps its stage when none is given', async () => {
  await call('POST', '/tasks', { sessionId: 's1', title: '예약 화면', stage: '설계' })
  const { json } = await call('POST', '/tasks', { sessionId: 's1', title: '예약 화면', now: '시안 비교' })
  assert.equal(json.stage, '설계')
  assert.equal(json.now, '시안 비교')
  assert.equal((await call('POST', '/tasks', { sessionId: 's1', title: 'x', stage: '모름' })).status, 400)
})

test('an answered question is delivered once, then acknowledged', async () => {
  const { json: q } = await call('POST', '/questions', {
    sessionId: 's1',
    taskTitle: '예약 화면',
    question: '취소 버튼을 어디에 둘까',
    options: [
      { key: 'a', label: '카드 안' },
      { key: 'b', label: '상단 바' },
    ],
    recommend: 'a',
  })
  assert.equal(typeof q.id, 'number')

  assert.equal((await call('POST', `/questions/${q.id}/answer`, { choice: 'z' })).status, 400)
  assert.equal((await call('POST', `/questions/${q.id}/answer`, {})).status, 400)

  const delivered = firstDelivery('s1')
  await call('POST', `/questions/${q.id}/answer`, { choice: 'a', memo: '모바일 우선' })
  const got = await delivered
  assert.equal(got.id, `q${q.id}`)
  assert.match(got.text, /고른 것: \(a\) 카드 안/)
  assert.match(got.text, /메모: 모바일 우선/)

  assert.equal((await call('POST', `/questions/${q.id}/answer`, { choice: 'b' })).status, 409)
  await call('POST', `/deliveries/${got.id}/ack`)
  const { json: state } = await call('GET', '/state')
  const row = state.questions.find((one: { id: number }) => one.id === q.id)
  assert.equal(row.delivered, 1)
  assert.ok(state.events.some((e: { kind: string }) => e.kind === '전달'))
})

test('a held question stays in the queue', async () => {
  const { json: q } = await call('POST', '/questions', { sessionId: 's1', question: '나중에 볼 것' })
  await call('POST', `/questions/${q.id}/hold`)
  const { json: state } = await call('GET', '/state')
  assert.equal(state.questions.find((one: { id: number }) => one.id === q.id).status, 'held')
})

test('a plan creates the task and its nodes, and checks what comes after what', async () => {
  const plan = {
    sessionId: 's1',
    taskTitle: '정산 화면',
    nodes: [
      { key: 'spec', title: '시험 기획', kind: '시험', stage: '설계' },
      { key: 'build', title: '화면 구현', after: ['spec'], stage: '작업' },
      { key: 'review', title: '독립 검토', kind: '검토', owner: '검토자', after: ['build'], stage: '작업' },
    ],
  }
  assert.equal((await call('POST', '/nodes', plan)).status, 200)
  const bad = { ...plan, nodes: [{ key: 'x', title: 'x', after: ['nope'] }] }
  assert.equal((await call('POST', '/nodes', bad)).status, 400)
  const { json: state } = await call('GET', '/state')
  assert.ok(state.tasks.some((t: { title: string }) => t.title === '정산 화면'))
  const review = state.nodes.find((n: { key: string }) => n.key === 'review')
  assert.equal(review.owner, '검토자')
  assert.deepEqual(JSON.parse(review.after), ['build'])
})

test('a node that starts again after ending counts a new round', async () => {
  const set = (status: string) => call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '정산 화면', key: 'build', status })
  assert.equal((await set('지금')).json.round, 1)
  assert.equal((await set('끝')).json.round, 1)
  assert.equal((await set('지금')).json.round, 2)
  assert.equal((await set('보류')).status, 400)
  assert.equal((await call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '정산 화면', key: 'zzz', status: '끝' })).status, 404)
})

test('a second bridge on a live socket refuses instead of taking it over', async () => {
  const other = createBridge(join(dir, 'other.db'), 'ko-KR')
  await assert.rejects(listen(other.server, socketPath), /이미/)
  other.db.close()
  assert.equal((await call('GET', '/health')).status, 200)
})

test('the task stage follows its first stage with unfinished nodes', async () => {
  const stageOf = async () =>
    (await call('GET', '/state')).json.tasks.find((t: { title: string }) => t.title === '단계 시험').stage
  await call('POST', '/nodes', {
    sessionId: 's1',
    taskTitle: '단계 시험',
    nodes: [
      { key: 'need', title: '요구 정리', stage: '요구' },
      { key: 'make', title: '구현', stage: '작업', after: ['need'] },
    ],
  })
  assert.equal(await stageOf(), '요구')
  const done = (key: string) => call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '단계 시험', key, status: '끝' })
  await done('need')
  assert.equal(await stageOf(), '작업')
  await done('make')
  assert.equal(await stageOf(), '완료')
})

test('a message from the IDE reaches its session and is acknowledged once', async () => {
  assert.equal((await call('POST', '/outbox', { sessionId: 'nobody', text: 'x' })).status, 404)
  const delivered = firstDelivery('s1')
  const { json } = await call('POST', '/outbox', { sessionId: 's1', kind: '화면 코멘트', text: '버튼 색을 바꿔 주세요' })
  const got = await delivered
  assert.equal(got.id, json.id)
  assert.equal(got.text, '버튼 색을 바꿔 주세요')
  await call('POST', `/deliveries/${got.id}/ack`)
  await call('POST', `/deliveries/${got.id}/ack`)
  const { json: state } = await call('GET', '/state')
  assert.equal(state.events.filter((e: { kind: string; text: string }) => e.kind === '전달' && e.text.startsWith('화면 코멘트')).length, 1)
})

test('an older mod acknowledging a bare number still marks the answer', async () => {
  const { json: q } = await call('POST', '/questions', { sessionId: 's1', question: '옛 방식', options: [{ key: 'a', label: '예' }] })
  await call('POST', `/questions/${q.id}/answer`, { choice: 'a' })
  await call('POST', `/deliveries/${q.id}/ack`)
  const { json: state } = await call('GET', '/state')
  assert.equal(state.questions.find((one: { id: number }) => one.id === q.id).delivered, 1)
})

test('a node keeps its worktree until it is cleared', async () => {
  const set = (body: Record<string, unknown>) => call('POST', '/nodes/worktree', { sessionId: 's1', taskTitle: '정산 화면', key: 'build', ...body })
  assert.equal((await set({ worktree: '/wt/build', branch: 'jung-build' })).status, 200)
  let node = (await call('GET', '/state')).json.nodes.find((n: { key: string }) => n.key === 'build')
  assert.equal(node.worktree, '/wt/build')
  assert.equal(node.branch, 'jung-build')
  assert.equal((await call('POST', '/nodes/worktree', { nodeId: node.id, worktree: null })).status, 200)
  node = (await call('GET', '/state')).json.nodes.find((n: { key: string }) => n.key === 'build')
  assert.equal(node.worktree, null)
  assert.equal((await set({ key: 'nope', worktree: '/x' })).status, 404)
})

test('a database from before the worktree columns gains them', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const old = join(dir, 'old.db')
  const legacy = new DatabaseSync(old)
  legacy.exec(`create table nodes (id integer primary key, task_id integer not null, key text not null, title text not null,
    kind text not null default '구현', owner text not null default '작업자', stage text, status text not null default '대기',
    after text not null default '[]', round integer not null default 1, note text not null default '', updated_at integer not null,
    unique (task_id, key))`)
  legacy.close()
  const migrated = createBridge(old, 'ko-KR')
  const columns = (migrated.db.prepare('pragma table_info(nodes)').all() as { name: string }[]).map(c => c.name)
  migrated.db.close()
  assert.ok(columns.includes('worktree') && columns.includes('branch'))
})

test('set_task fills the summary fields, numbers the task, and keeps fields it was not given', async () => {
  await call('POST', '/tasks', { sessionId: 's1', title: '요약 시험', why: '사용자 요청', artifact: 'PR #344', tests: '통과 304, 실패 0' })
  const { json } = await call('POST', '/tasks', { sessionId: 's1', title: '요약 시험', result: 'PR #366 머지해도 됨' })
  assert.equal(json.why, '사용자 요청')
  assert.equal(json.result, 'PR #366 머지해도 됨')
  assert.equal(typeof json.number, 'number')
})

test('archiving moves a task aside, and new activity brings it back', async () => {
  const id = (await call('POST', '/tasks', { sessionId: 's1', title: '보관 시험', stage: '완료' })).json.id
  assert.equal((await call('POST', '/tasks/archive-done')).json.count >= 1, true)
  let state = (await call('GET', '/state')).json
  assert.ok(state.archived.some((t: { id: number }) => t.id === id))
  assert.ok(!state.tasks.some((t: { id: number }) => t.id === id))
  await call('POST', '/questions', { sessionId: 's1', taskTitle: '보관 시험', question: '다시 볼까', options: [{ key: 'a', label: '예' }] })
  state = (await call('GET', '/state')).json
  const back = state.tasks.find((t: { id: number }) => t.id === id)
  assert.equal(back.status, '하는 중')
  assert.ok(back.restored_at)
})

test('agents tie to nodes by their description and log when they end', async () => {
  await call('POST', '/agents', { sessionId: 's1', agents: [{ id: 'ag1', description: '[정산 화면::build] 화면 구현', status: 'running' }] })
  await call('POST', '/agents', { sessionId: 's1', agents: [{ id: 'ag1', description: '[정산 화면::build] 화면 구현', status: 'completed' }] })
  const state = (await call('GET', '/state')).json
  const agent = state.agents.find((a: { id: string }) => a.id === 'ag1')
  assert.deepEqual([agent.task_title, agent.node_key, agent.status], ['정산 화면', 'build', 'completed'])
  assert.ok(state.events.some((e: { kind: string; text: string }) => e.kind === '작업자' && e.text.startsWith('끝')))
})

test('a command reaches the mod at once and records its result', async () => {
  const got = new Promise<{ id: number; kind: string; payload: { agentId: string } }>((resolve, reject) => {
    const req = request({ socketPath, path: '/deliveries?session=s1' }, res => {
      let buffer = ''
      res.on('data', chunk => {
        buffer += chunk
        const match = buffer.match(/event: command\ndata: (.*)\n\n/)
        if (match) {
          resolve(JSON.parse(match[1] ?? '{}'))
          req.destroy()
        }
      })
    })
    req.on('error', error => (error.message.includes('aborted') ? undefined : reject(error)))
    req.end()
  })
  assert.equal((await call('POST', '/commands', { sessionId: 's1', kind: 'explode' })).status, 400)
  const { json } = await call('POST', '/commands', { sessionId: 's1', kind: 'pause', payload: { agentId: 'ag1' } })
  const command = await got
  assert.deepEqual([command.id, command.kind, command.payload.agentId], [json.id, 'pause', 'ag1'])
  await call('POST', `/commands/${json.id}/done`, { result: { ok: true } })
  const row = (await call('GET', `/commands/${json.id}`)).json
  assert.ok(row.done_at)
  assert.deepEqual(row.result, { ok: true })
})

test('usage and settings are stored', async () => {
  await call('POST', '/sessions/usage', { sessionId: 's1', usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 39 }] } })
  await call('POST', '/settings', { key: 'theme', value: 'crt' })
  const state = (await call('GET', '/state')).json
  assert.equal(JSON.parse(state.sessions.find((s: { id: string }) => s.id === 's1').usage).rateLimits[0].percentUsed, 39)
  assert.equal(state.settings.theme, 'crt')
  await call('POST', '/settings', { key: 'theme', value: null })
  assert.equal((await call('GET', '/state')).json.settings.theme, undefined)
})

test('errors read as Korean sentences and keep their status', async () => {
  const { json: q } = await call('POST', '/questions', { sessionId: 's1', question: '색', options: [{ key: 'a', label: '빨강' }, { key: 'b', label: '파랑' }] })
  const wrong = await call('POST', `/questions/${q.id}/answer`, { choice: 'z' })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.json.error, '선택지는 a, b 중에서 골라야 합니다')
  await call('POST', `/questions/${q.id}/answer`, { choice: 'a' })
  assert.equal((await call('POST', `/questions/${q.id}/answer`, { choice: 'b' })).json.error, `Q${q.id}에는 이미 답했습니다`)
  assert.equal((await call('POST', '/outbox', { sessionId: 'nobody', text: 'x' })).json.error, '세션을 찾을 수 없습니다: nobody')
  assert.equal((await call('GET', '/nowhere')).json.error, '없는 경로입니다: GET /nowhere')
})

// Feature area: UI language. The `lang` setting decides how the bridge words errors,
// log lines and the text it sends to sessions; stored values stay Korean.
test('errors, log lines and answers follow the lang setting', async () => {
  await call('POST', '/settings', { key: 'lang', value: 'en' })
  try {
    assert.equal((await call('GET', '/nowhere')).json.error, 'No such route: GET /nowhere')
    const bad = await call('POST', '/tasks', { sessionId: 's1', title: 'x', stage: 'later' })
    assert.equal(bad.json.error, 'Stage must be one of 요구, 설계, 작업, 완료')
    await call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '정산 화면', key: 'review', status: '끝' })
    const last = (await call('GET', '/state')).json.events.at(-1)
    assert.equal(last.kind, '끝')
    assert.equal(last.text, 'Done, Reviewer: 독립 검토')
    const { json: q } = await call('POST', '/questions', { sessionId: 'en1', question: 'Where?', options: [{ key: 'a', label: 'Top' }] })
    const got = firstDelivery('en1')
    await call('POST', `/questions/${q.id}/answer`, { choice: 'a', memo: 'mobile first' })
    assert.equal(
      (await got).text,
      `[Switchboard] Q${q.id} has been answered.\nQuestion: Where?\nChoice: (a) Top\nMemo: mobile first\nContinue the work that was waiting on this answer.`,
    )
  } finally {
    await call('POST', '/settings', { key: 'lang', value: null })
  }
  assert.equal((await call('GET', '/nowhere')).json.error, '없는 경로입니다: GET /nowhere')
})

test('the answer text and node log lines in each language', () => {
  const q = { id: 7, question: '색', options: JSON.stringify([{ key: 'a', label: '빨강' }]), choice: null, memo: '알아서' } as never
  assert.match(deliveryText(q), /^\[Switchboard\] Q7 답이 왔습니다\.\n질문: 색\n고른 것: 없음 \(메모만 보냄\)\n메모: 알아서/)
  assert.match(deliveryText(q, 'ja'), /^\[Switchboard\] Q7 に回答がありました。/)
  assert.match(deliveryText(q, 'zh-CN'), /选择：无/)
  assert.equal(nodeEventText('지금', '사용자', 'Pick', 1, false, '', 'en'), 'Started, User: Pick')
  assert.equal(nodeEventText('지금', '검토자', 'Check', 3, true, 'PR #1', 'en'), 'Restarted, Reviewer: Check (round 3) / PR #1')
})

test('a later plan may put a node after one an earlier plan made', async () => {
  const plan = (nodes: unknown[]) => call('POST', '/nodes', { sessionId: 's1', taskTitle: '나눠 올리기', nodes })
  assert.equal((await plan([{ key: 'b', title: '첫 노드' }])).status, 200)
  assert.equal((await plan([{ key: 'c', title: '다음 노드', after: ['b'] }])).status, 200)
  const bad = await plan([{ key: 'd', title: '없는 선행', after: ['zz'] }])
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, '노드 d의 선행 노드를 찾을 수 없습니다: zz')
  // Keys of another task do not count.
  assert.equal((await call('POST', '/nodes', { sessionId: 's1', taskTitle: '다른 작업', nodes: [{ key: 'e', title: 'e', after: ['b'] }] })).status, 400)
})

test('node status events name the owner and mark a restart', async () => {
  assert.equal(nodeEventText('끝', '작업자', '화면 구현', 1, false), '끝, 작업자: 화면 구현')
  assert.equal(nodeEventText('지금', '검토자', '독립 검토', 2, true), '다시 시작, 검토자: 독립 검토 (2회차)')
  await call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '정산 화면', key: 'review', status: '끝' })
  await call('POST', '/nodes/status', { sessionId: 's1', taskTitle: '정산 화면', key: 'review', status: '지금' })
  const texts = (await call('GET', '/state')).json.events.map((e: { text: string }) => e.text)
  assert.ok(texts.includes('끝, 검토자: 독립 검토'))
  assert.ok(texts.includes('다시 시작, 검토자: 독립 검토 (2회차)'))
})

test('a command goes once to an open stream, and every pending one to a new stream', async () => {
  await call('POST', '/sessions', { id: 's-cmd', cwd: '/work/cmd' })
  const open = frames('s-cmd', 'command', 2)
  await new Promise(resolve => setTimeout(resolve, 50))
  const first = (await call('POST', '/commands', { sessionId: 's-cmd', kind: 'report' })).json.id
  const second = (await call('POST', '/commands', { sessionId: 's-cmd', kind: 'sync' })).json.id
  const got = await open
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(got.map(c => c.id), [first, second])
  const fresh = await frames('s-cmd', 'command', 2)
  assert.deepEqual(fresh.map(c => c.id), [first, second])
})

test('archive-done can stay inside one project and leaves a restored task alone', async () => {
  await call('POST', '/sessions', { id: 's-p1', cwd: '/work/alpha' })
  await call('POST', '/sessions', { id: 's-p2', cwd: '/work/beta' })
  const a = (await call('POST', '/tasks', { sessionId: 's-p1', title: '알파 끝', stage: '완료' })).json.id
  const b = (await call('POST', '/tasks', { sessionId: 's-p2', title: '베타 끝', stage: '완료' })).json.id
  assert.equal((await call('POST', '/tasks/archive-done', { project: 'alpha' })).json.count, 1)
  let state = (await call('GET', '/state')).json
  assert.ok(state.archived.some((t: { id: number }) => t.id === a))
  assert.ok(state.tasks.some((t: { id: number }) => t.id === b))
  await call('POST', `/tasks/${a}/restore`)
  await call('POST', '/tasks/archive-done')
  state = (await call('GET', '/state')).json
  assert.ok(state.tasks.some((t: { id: number }) => t.id === a), 'restored task stays')
  assert.ok(state.archived.some((t: { id: number }) => t.id === b))
  await new Promise(resolve => setTimeout(resolve, 5))
  await call('POST', '/tasks', { sessionId: 's-p1', title: '알파 끝', now: '다시 손봄' })
  await call('POST', '/tasks/archive-done', { project: 'alpha' })
  assert.ok((await call('GET', '/state')).json.archived.some((t: { id: number }) => t.id === a), 'archived again after new activity')
})

test('two folders with the same name become two projects', async () => {
  assert.equal(projectName('/a/web', []), 'web')
  assert.equal(projectName('/b/web', [{ project: 'web', cwd: '/a/web' }]), 'b/web')
  assert.equal(projectName('/a/web', [{ project: 'web', cwd: '/a/web' }]), 'web')
  assert.equal((await call('POST', '/sessions', { id: 'w1', cwd: '/a/web' })).json.project, 'web')
  assert.equal((await call('POST', '/sessions', { id: 'w2', cwd: '/b/web' })).json.project, 'b/web')
  assert.equal((await call('POST', '/sessions', { id: 'w3', cwd: '/a/web' })).json.project, 'web')
  // Registering again on reconnect keeps the name.
  assert.equal((await call('POST', '/sessions', { id: 'w2', cwd: '/b/web' })).json.project, 'b/web')
})

test('state counts answers per project and lists every running task', async () => {
  const state = (await call('GET', '/state')).json
  const total = Object.values(state.answeredByProject as Record<string, number>).reduce((a, b) => a + b, 0)
  assert.equal(total, state.answeredCount)
  assert.ok(state.answeredByProject['music-app'] >= 1)
  const db = bridge.db
  const insert = db.prepare("insert into tasks (session_id, project, title, status, created_at, updated_at) values ('s-many', 'many', ?, ?, ?, ?)")
  for (let i = 0; i < 210; i++) insert.run(`대기 ${i}`, '대기', Date.now() + 1000, Date.now() + 1000)
  insert.run('오래 돈 작업', '하는 중', 1, 1)
  const after = (await call('GET', '/state')).json
  assert.ok(after.tasks.some((t: { title: string }) => t.title === '오래 돈 작업'))
  db.exec("delete from tasks where session_id = 's-many'")
})

test('pruning keeps questions and drops old delivered, done and stale rows', async () => {
  const db = bridge.db
  const later = Date.now() + 8 * 24 * 3600_000
  await call('POST', '/sessions', { id: 's-old', cwd: '/work/old' })
  db.prepare("insert into commands (session_id, kind, created_at) values ('s-old', 'report', 1)").run()
  db.prepare("insert into commands (session_id, kind, created_at, done_at) values ('s1', 'report', 1, 1)").run()
  db.prepare("insert into outbox (session_id, text, created_at, delivered) values ('s1', '오래된 것', 1, 1)").run()
  db.prepare("insert into agents (id, session_id, status, created_at, updated_at) values ('old-ag', 's1', 'completed', 1, 1)").run()
  const questions = (db.prepare('select count(*) n from questions').get() as { n: number }).n
  bridge.prune(later)
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  assert.equal(count("select count(*) n from commands where session_id = 's-old'"), 0)
  assert.equal(count('select count(*) n from commands where done_at = 1'), 0)
  assert.equal(count("select count(*) n from outbox where text = '오래된 것'"), 0)
  assert.equal(count("select count(*) n from agents where id = 'old-ag'"), 0)
  assert.equal(count('select count(*) n from questions'), questions)
})

test('the socket and the database are private to their owner', () => {
  assert.equal(statSync(socketPath).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'ide.db')).mode & 0o777, 0o600)
})

// Dynamic debugging routes (bridge/debug.ts).
describe('dynamic debugging', () => {
  test('a comment is kept per page, sending marks it 보냄, and it survives a new bridge on the same database', async () => {
    const page = 'http://127.0.0.1:8980/inspect'
    const added = await call('POST', '/comments', {
      url: `${page}#top`,
      place: '본문 › 현황판 쪽 › "미시작" 꼬리표',
      css: 'main > span.badge',
      element: 'span "미시작"',
      text: '색을 진하게',
      shot: '/tmp/shot.png',
    })
    assert.equal(added.status, 200)
    assert.deepEqual([added.json.url, added.json.status, added.json.sent_at], [page, '열림', null])
    await call('POST', '/comments', { url: 'http://127.0.0.1:8980/other', text: '다른 쪽' })
    assert.equal((await call('POST', '/comments', { url: page, text: ' ' })).status, 400)

    const listed = (await call('GET', `/comments?url=${encodeURIComponent(page)}`)).json.comments
    assert.deepEqual(listed.map((c: { text: string }) => c.text), ['색을 진하게'])

    const sent = await call('POST', '/comments/status', { ids: [added.json.id], status: '보냄', sessionId: 's1' })
    assert.equal(sent.json.count, 1)
    assert.equal((await call('POST', '/comments/status', { ids: [added.json.id], status: '지움' })).status, 400)
    const after = (await call('GET', `/comments?url=${encodeURIComponent(page)}&status=${encodeURIComponent('보냄')}`)).json.comments[0]
    assert.equal(after.session_id, 's1')
    assert.ok(after.sent_at)

    const again = createBridge(join(dir, 'ide.db'), 'ko-KR')
    const kept = again.db.prepare('select status, place from comments where id = ?').get(added.json.id) as { status: string; place: string }
    again.close()
    assert.deepEqual({ ...kept }, { status: '보냄', place: '본문 › 현황판 쪽 › "미시작" 꼬리표' })

    await call('POST', '/comments/status', { ids: [added.json.id], status: '해결' })
    const resolved = (await call('GET', `/comments?url=${encodeURIComponent(page)}`)).json.comments[0]
    assert.equal(resolved.status, '해결')
    assert.ok(resolved.resolved_at)
    assert.equal((await call('POST', `/comments/${added.json.id}`, { text: '색을 더 진하게' })).json.text, '색을 더 진하게')
    assert.equal((await call('POST', `/comments/${added.json.id}/delete`)).json.deleted, true)
    assert.equal((await call('GET', `/comments?url=${encodeURIComponent(page)}`)).json.comments.length, 0)
    assert.equal((await call('POST', `/comments/${added.json.id}/delete`)).status, 404)
  })

  test('open_in_ide registers the dev target and tells the IDE through its stream', async () => {
    const got = new Promise<{ type: string; open: { url: string; restart: boolean; target: { id: string; port: number } } }>((resolve, reject) => {
      const req = request({ socketPath, path: '/stream' }, res => {
        let buffer = ''
        res.on('data', chunk => {
          buffer += chunk
          const match = buffer.match(/data: (\{"type":"devOpen".*)\n\n/)
          if (match) {
            resolve(JSON.parse(match[1] ?? '{}'))
            req.destroy()
          }
        })
      })
      req.on('error', error => (error.message.includes('aborted') ? undefined : reject(error)))
      req.end()
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await call('POST', '/dev/open', { url: 'ftp://x' })).status, 400)
    const opened = await call('POST', '/dev/open', { url: '127.0.0.1:8951', name: '검수 앱', repo: '/tmp/app', command: 'pnpm dev', sessionId: 's1' })
    assert.equal(opened.status, 200)
    assert.deepEqual([opened.json.created, opened.json.restart, opened.json.ideWatching], [true, true, true])
    // Kept for an app that was still starting when the request came.
    assert.equal((await call('GET', '/dev/open')).json.open.id, opened.json.id)
    const event = await got
    assert.equal(event.open.url, 'http://127.0.0.1:8951')
    assert.equal(event.open.target.port, 8951)
    const targets = (await call('GET', '/state')).json.settings.devTargets
    assert.deepEqual(targets.map((t: { name: string }) => t.name), ['검수 앱'])

    const reopened = await call('POST', '/dev/open', { url: 'http://127.0.0.1:8951/list' })
    assert.deepEqual([reopened.json.created, reopened.json.restart, reopened.json.target.id], [false, false, event.open.target.id])
    assert.equal((await call('GET', '/state')).json.settings.devTargets.length, 1)
    assert.equal((await call('GET', '/dev/open')).json.open.id, reopened.json.id)
  })

  test('live sessions are the ones holding their delivery stream open', async () => {
    const req = request({ socketPath, path: '/deliveries?session=live-1' })
    req.on('error', () => undefined)
    req.end()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok((await call('GET', '/sessions/live')).json.ids.includes('live-1'))
    req.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(!(await call('GET', '/sessions/live')).json.ids.includes('live-1'))
  })
})

describe('agent CLIs other than Claude Code', () => {
  test('a database from before the agent columns gains them, and its sessions are Claude', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const old = join(dir, 'old-agents.db')
    const legacy = new DatabaseSync(old)
    legacy.exec(`create table sessions (id text primary key, project text not null, cwd text not null,
      started_at integer not null, last_seen integer not null)`)
    legacy.exec("insert into sessions values ('old-1', 'web', '/work/web', 1, 1)")
    legacy.close()
    const migrated = createBridge(old)
    const row = migrated.db.prepare('select agent, terminal from sessions where id = ?').get('old-1') as { agent: string; terminal: string }
    migrated.close()
    assert.deepEqual([row.agent, row.terminal], ['claude', ''])
  })

  test('a session names its agent and terminal, keeps them on a bare reconnect, and /state returns them', async () => {
    assert.equal((await call('POST', '/sessions', { id: 'cx1', cwd: '/work/cli-app', agent: 'Codex!' })).status, 400)
    assert.equal((await call('POST', '/sessions', { id: 'cx1', cwd: '/work/cli-app', terminal: 'a b' })).status, 400)
    await call('POST', '/sessions', { id: 'cx1', cwd: '/work/cli-app', agent: 'codex', terminal: 'r1-t2' })
    await call('POST', '/sessions', { id: 'cx1', cwd: '/work/cli-app' })
    await call('POST', '/sessions', { id: 'cl1', cwd: '/work/cli-app' })
    const sessions = (await call('GET', '/state')).json.sessions as { id: string; agent: string; terminal: string }[]
    const pick = (id: string) => sessions.find(s => s.id === id)
    assert.deepEqual([pick('cx1')?.agent, pick('cx1')?.terminal], ['codex', 'r1-t2'])
    assert.deepEqual([pick('cl1')?.agent, pick('cl1')?.terminal], ['claude', ''])
  })

  test('seen keeps a session fresh without a change event, and says when the bridge does not know it', async () => {
    await call('POST', '/sessions', { id: 'cx2', cwd: '/work/cli-app', agent: 'gemini' })
    bridge.db.prepare('update sessions set last_seen = 5 where id = ?').run('cx2')
    assert.equal((await call('POST', '/sessions/seen', { sessionId: 'cx2' })).status, 200)
    const row = bridge.db.prepare('select last_seen from sessions where id = ?').get('cx2') as { last_seen: number }
    assert.ok(row.last_seen > 5)
    assert.equal((await call('POST', '/sessions/seen', { sessionId: 'nobody' })).status, 404)
  })

  test('take hands over answers and messages once, oldest first, and turns only prompt commands back', async () => {
    await call('POST', '/sessions', { id: 'cx3', cwd: '/work/cli-app', agent: 'codex' })
    const { json: q } = await call('POST', '/questions', { sessionId: 'cx3', question: '어느 쪽으로', options: [{ key: 'a', label: '왼쪽' }] })
    await call('POST', `/questions/${q.id}/answer`, { choice: 'a' })
    await call('POST', '/outbox', { sessionId: 'cx3', text: '화면 코멘트 하나' })
    const report = (await call('POST', '/commands', { sessionId: 'cx3', kind: 'report' })).json.id
    const pause = (await call('POST', '/commands', { sessionId: 'cx3', kind: 'pause', payload: { agentId: 'x' } })).json.id

    const taken = (await call('POST', '/deliveries/take', { sessionId: 'cx3' })).json
    assert.deepEqual(taken.items.map((i: { id: string }) => i.id), [`q${q.id}`, taken.items[1].id])
    assert.match(taken.items[0].text, /\[Switchboard\] Q\d+ 답이 왔습니다/)
    assert.equal(taken.items[1].text, '화면 코멘트 하나')
    assert.deepEqual(taken.commands.map((c: { id: number; kind: string }) => [c.id, c.kind]), [[report, 'report']])
    assert.ok((await call('GET', `/commands/${pause}`)).json.result.error)

    const again = (await call('POST', '/deliveries/take', { sessionId: 'cx3' })).json
    assert.deepEqual([again.items.length, again.commands.length], [0, 0])
    const state = (await call('GET', '/state')).json
    assert.equal(state.questions.find((one: { id: number }) => one.id === q.id).delivered, 1)
    assert.equal((await call('POST', '/deliveries/take', { sessionId: 'nobody' })).status, 404)
  })
})

describe('messages between sessions', () => {
  const take = async (sessionId: string) => (await call('POST', '/deliveries/take', { sessionId })).json.items as { id: string; text: string }[]
  // A session whose delivery stream stays open counts as live (heldReply waits only for live ones).
  const hold = (sessionId: string) => {
    const req = request({ socketPath, path: `/deliveries?session=${sessionId}` })
    req.on('error', () => undefined)
    req.end()
    return req
  }

  test('a request reads as collaborator input with how to answer, and the reply goes back once', async () => {
    for (const [id, cwd] of [['pa', '/w/front'], ['pb', '/w/back']]) await call('POST', '/sessions', { id, cwd })
    assert.equal((await call('POST', '/messages', { sessionId: 'pa', to: ['pa'], text: 'x' })).status, 400)
    assert.equal((await call('POST', '/messages', { sessionId: 'pa', to: ['nobody'], text: 'x' })).status, 404)
    const sent = (await call('POST', '/messages', { sessionId: 'pa', to: ['pb'], text: '주문 API 응답 형식을 알려줘', requestKey: 'toolu_p1' })).json
    assert.equal(sent.ids.length, 1)
    assert.deepEqual((await call('POST', '/messages', { sessionId: 'pa', to: ['pb'], text: '주문 API 응답 형식을 알려줘', requestKey: 'toolu_p1' })).json, { ids: sent.ids, duplicate: true })
    const [got] = await take('pb')
    assert.equal(got?.id, sent.ids[0])
    assert.match(got!.text, /front \(pa\)이\(가\) 보낸 메시지/)
    assert.match(got!.text, /협업자 입력/)
    assert.match(got!.text, new RegExp(`replyTo "${sent.ids[0]}"`))
    assert.match(got!.text, /마지막 답변이 그대로 결과로/)
    assert.match(got!.text, /--- 메시지 ---\n주문 API 응답 형식을 알려줘$/)

    // A reply needs no `to`, wants no answer, and the turn's end then sends nothing more.
    assert.equal((await call('POST', '/messages', { sessionId: 'pa', replyTo: sent.ids[0], text: 'x' })).status, 400)
    const reply = (await call('POST', '/messages', { sessionId: 'pb', replyTo: sent.ids[0], text: '상태: 완료\n결과: { id, items }\n근거: api/orders.ts' })).json
    assert.equal(reply.ids.length, 1)
    assert.equal((await call('POST', '/messages/turn-end', { sessionId: 'pb', ids: sent.ids, answer: '끝' })).json.relayed, 0)
    const [back] = await take('pa')
    assert.match(back!.text, new RegExp(`요청 ${sent.ids[0]}에 대한 답`))
    assert.match(back!.text, /보낸 세션 이름으로 시작해/)
    assert.doesNotMatch(back!.text, /send_to_session으로 결과를 보내세요/)
  })

  test('a request the turn ended without answering gets the last answer, once', async () => {
    const sent = (await call('POST', '/messages', { sessionId: 'pa', to: ['pb'], text: '테스트 돌려줘' })).json
    await take('pb')
    assert.equal((await call('POST', '/messages/turn-end', { sessionId: 'pb', ids: sent.ids, answer: '' })).json.relayed, 0)
    assert.equal((await call('POST', '/messages/turn-end', { sessionId: 'pb', ids: sent.ids, answer: '상태: 완료' })).json.relayed, 1)
    assert.equal((await call('POST', '/messages/turn-end', { sessionId: 'pb', ids: sent.ids, answer: '상태: 완료' })).json.relayed, 0)
    const items = await take('pa')
    assert.equal(items.length, 1)
    assert.match(items[0]!.text, /상태: 완료$/)
  })

  test('information wants no answer and the turn end relays nothing', async () => {
    const sent = (await call('POST', '/messages', { sessionId: 'pa', to: ['pb'], text: '배포 끝남', expectsReply: false })).json
    const [got] = await take('pb')
    assert.match(got!.text, /답장이나 확인을 보내지 마세요/)
    assert.equal((await call('POST', '/messages/turn-end', { sessionId: 'pb', ids: sent.ids, answer: '알겠습니다' })).json.relayed, 0)
  })

  test('answers to a request sent to several live sessions come together', async () => {
    await call('POST', '/sessions', { id: 'pc', cwd: '/w/infra' })
    const streams = [hold('pb'), hold('pc')]
    await new Promise(resolve => setTimeout(resolve, 50))
    const sent = (await call('POST', '/messages', { sessionId: 'pa', to: ['pb', 'pc'], text: '각자 의견' })).json
    assert.equal(sent.ids.length, 2)
    await call('POST', '/messages', { sessionId: 'pb', replyTo: sent.ids[0], text: 'b 의견' })
    assert.equal((await take('pa')).length, 0)
    await call('POST', '/messages', { sessionId: 'pc', replyTo: sent.ids[1], text: 'c 의견' })
    assert.deepEqual((await take('pa')).map(item => item.text.split('\n').at(-1)), ['b 의견', 'c 의견'])
    for (const stream of streams) stream.destroy()
    await take('pb')
    await take('pc')
  })

  test('a forwarded question is answered by the session it went to', async () => {
    const q = (await call('POST', '/questions', { sessionId: 'pa', question: '캐시 만료를 몇 분으로', options: [{ key: 'a', label: '5분' }, { key: 'b', label: '30분' }], recommend: 'a' })).json
    assert.equal((await call('POST', `/questions/${q.id}/forward`, { to: 'pa' })).status, 400)
    const fwd = (await call('POST', `/questions/${q.id}/forward`, { to: 'pb' })).json
    const [got] = await take('pb')
    assert.equal(got!.id, fwd.message)
    assert.match(got!.text, new RegExp(`front \\(pa\\)의 결정 질문 Q${q.id}`))
    assert.match(got!.text, /\(a\) 5분 \(질문한 세션의 추천\)/)
    const reply = (await call('POST', '/messages', { sessionId: 'pb', replyTo: fwd.message, text: 'b\n트래픽이 적어서 길게' })).json
    assert.equal(reply.answered, `Q${q.id}`)
    const row = (await call('GET', '/state')).json.questions.find((one: { id: number }) => one.id === q.id)
    assert.equal(row.status, 'answered')
    assert.equal(row.choice, 'b')
    assert.match(row.memo, /back \(pb\)의 답: b\n트래픽이 적어서 길게/)
    assert.equal((await call('POST', `/questions/${q.id}/forward`, { to: 'pb' })).status, 409)
    await take('pa')
  })

  test('peers list the other sessions with their task, connected first', async () => {
    await call('POST', '/tasks', { sessionId: 'pb', title: '주문 API', now: '응답 형식 정리' })
    const stream = hold('pb')
    await new Promise(resolve => setTimeout(resolve, 50))
    const { peers } = (await call('GET', '/sessions/peers?session=pa')).json
    assert.ok(!peers.some((p: { id: string }) => p.id === 'pa'))
    assert.equal(peers[0].id, 'pb')
    assert.equal(peers[0].live, true)
    assert.equal(peers[0].task, '주문 API')
    stream.destroy()
  })
})
