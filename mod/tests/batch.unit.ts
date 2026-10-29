import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchText, nextDelay, normalizeIds, parseFrame, pendingLine, remember, restateText, staleKeys, approvalSummary, toastText } from '../hooks/batch.ts'

test('one delivery goes in as it is', () => {
  assert.equal(batchText([{ id: 'q6', text: 'Q6 답' }]), 'Q6 답')
})

test('several deliveries become one prompt, in arrival order', () => {
  const text = batchText([
    { id: 'q6', text: 'Q6 답' },
    { id: 'q7', text: 'Q7 답' },
    { id: 'm1', text: '화면 코멘트' },
  ])
  assert.match(text, /3건이 도착했습니다/)
  assert.ok(text.indexOf('Q6 답') < text.indexOf('Q7 답'))
  assert.ok(text.indexOf('Q7 답') < text.indexOf('화면 코멘트'))
})

test('stored numbers and q ids are the same answers', () => {
  assert.deepEqual(normalizeIds([6, 'q7', 'm1']), ['q6', 'q7', 'm1'])
})

test('the toast names the answers and counts messages', () => {
  assert.equal(toastText([{ id: 'q6', text: '' }, { id: 'm2', text: '' }]), 'Q6 답, IDE 메시지 1건을 세션에 넣었습니다')
})

test('a delivery that mentions a command event stays a delivery', () => {
  const text = '로그에 event: command 줄이 보입니다'
  const frame = `event: delivery\ndata: ${JSON.stringify({ id: 'm3', text })}`
  assert.deepEqual(parseFrame(frame), { event: 'delivery', data: JSON.stringify({ id: 'm3', text }) })
  assert.equal(parseFrame('event: command\ndata: {"id":4}')?.event, 'command')
  assert.equal(parseFrame(': connected'), undefined)
})

test('remembered ids stay unique, newest last, and capped', () => {
  assert.deepEqual(remember([1, 2, 3], [2, 4], 3), [3, 2, 4])
  assert.deepEqual(remember<number>([], [7], 500), [7])
})

test('reconnecting waits longer each time, up to a minute', () => {
  assert.equal(nextDelay(0), 3000)
  assert.equal(nextDelay(3000), 6000)
  assert.equal(nextDelay(48000), 60000)
  assert.equal(nextDelay(60000), 60000)
})

test('a waiting question shows the recommended option by its label', () => {
  const options = JSON.stringify([{ key: 'a', label: '지금 고침' }, { key: 'b', label: '나중에' }])
  assert.equal(pendingLine({ id: 3, task_title: '정산', question: '어떻게 할까', recommend: 'a', options }), '- Q3 [정산] 어떻게 할까 추천 ➡ (a) 지금 고침')
  assert.equal(pendingLine({ id: 4, task_title: '', question: '메모만', recommend: '', options: '[]' }), '- Q4 [작업 없음] 메모만')
})

test('only the store keys of sessions gone too long are stale', () => {
  const keys = ['sent:old', 'commands:old', 'sent:new', 'seen', 'sent:unknown']
  assert.deepEqual(staleKeys(keys, { old: 0, new: 900 }, 1000, 500), ['sent:old', 'commands:old'])
})

test('after a compaction the prompt restates the session tasks, nodes, open questions and waits', () => {
  const state = {
    tasks: [
      { id: 1, session_id: 's', title: '결제', stage: '작업', status: '하는 중', now: 'PG 응답 처리' },
      { id: 2, session_id: 's', title: '옛 작업', stage: '완료', status: '보관', now: '' },
      { id: 3, session_id: 'other', title: '남의 작업', stage: '작업', status: '하는 중', now: '' },
    ],
    nodes: [{ task_id: 1, key: 'impl', title: '재시도 구현', status: '지금' }],
    questions: [
      { id: 7, session_id: 's', question: '재시도 몇 번?', status: 'pending' },
      { id: 8, session_id: 's', question: '끝난 질문', status: 'answered' },
    ],
  }
  const text = restateText(state, [{ id: 3, note: 'CI가 끝나면 배포\n둘째 줄' }], 's', 'ko')!
  assert.match(text, /^\[Switchboard\] 대화가 압축되었습니다/)
  assert.match(text, /작업: 결제 \(작업, 하는 중\) 지금: PG 응답 처리\n {2}- impl \[지금\] 재시도 구현/)
  assert.match(text, /답 기다리는 질문: Q7 재시도 몇 번\?/)
  assert.match(text, /열린 대기: w3 CI가 끝나면 배포$/)
  assert.doesNotMatch(text, /옛 작업|남의 작업|끝난 질문/)
  assert.equal(restateText({ tasks: [] }, [], 's'), undefined)
})

test('a permission ask reads as what would run', () => {
  assert.equal(approvalSummary('Bash', { command: 'rm -rf dist', description: '빌드 폴더 지우기' }), '빌드 폴더 지우기\nrm -rf dist')
  assert.equal(approvalSummary('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }), '/a.ts\n- x\n+ y')
  assert.equal(approvalSummary('WebFetch', { url: 'https://x.dev' }), 'https://x.dev')
  assert.match(approvalSummary('mcp__db__query', { sql: 'drop table t' }), /"sql": "drop table t"/)
  assert.equal(approvalSummary('Bash', { command: 'x'.repeat(2000) }).length, 1500)
})
