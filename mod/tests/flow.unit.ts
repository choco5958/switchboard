import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDOFF_TEXT,
  ageText,
  agentLine,
  agentRows,
  agentStatusText,
  agentTitle,
  bandText,
  cells,
  columnsOf,
  paneAction,
  costText,
  countChips,
  countsLine,
  countsOf,
  graphLayout,
  isHandoff,
  markOf,
  nodeBox,
  nodeTone,
  parseState,
  plannerOf,
  progressBar,
  progressText,
  questionLine,
  recommendLine,
  refreshText,
  splitRow,
  summaryLines,
  taskMeta,
  transcriptLines,
  truncate,
} from '../hooks/flow.ts'
import type { FlowAgent, FlowNode } from '../types/index.d.ts'

const STATE = {
  sessions: [
    { id: 's1', project: 'p', usage: JSON.stringify({ cost: { totalUsd: 12.345 }, rateLimits: [] }) },
    { id: 's2', project: 'p', usage: '{}' },
  ],
  tasks: [
    { id: 7, session_id: 's1', title: '정답지 고도화', stage: '작업', status: '하는 중', now: '재채점', number: 12, branch: 'feat/x', artifact: 'PR #293' },
    { id: 8, session_id: 's1', title: '문서 정리', stage: '요구', status: '대기', now: '', number: null, branch: '', artifact: '' },
    { id: 9, session_id: 's2', title: '다른 세션', stage: '작업', status: '하는 중', now: '', number: 9 },
  ],
  nodes: [
    { task_id: 7, key: 'a', title: 'IR 추출', kind: '구현', owner: '작업자', status: '끝', after: '[]', round: 1 },
    { task_id: 7, key: 'b', title: '고도화 구현', kind: '구현', owner: '작업자', status: '지금', after: '["a"]', round: 2 },
    { task_id: 7, key: 'c', title: '독립 검토', kind: '검토', owner: '검토자', status: '대기', after: '["b"]', round: 1 },
    { task_id: 7, key: 'd', title: '원문 읽기', status: '대기', after: '["a"]', round: 1 },
    { task_id: 7, key: 'e', title: '배포', status: '실패', after: 'not json', round: 1 },
    { task_id: 9, key: 'z', title: '남의 노드', status: '대기', after: '[]', round: 1 },
  ],
  agents: [
    { id: 'g1', session_id: 's1', task_title: '정답지 고도화', description: '[정답지 고도화::b] 검수', status: 'running', updated_at: 900 },
    { id: 'g2', session_id: 's1', task_title: '정답지 고도화', description: '추출', status: 'completed', updated_at: 800 },
    { id: 'g3', session_id: 's2', task_title: '다른 세션', description: '남', status: 'running' },
  ],
  questions: [
    { id: 14, session_id: 's1', task_title: '', question: '배포할까요?', status: 'pending' },
    {
      id: 12,
      session_id: 's1',
      task_title: '정답지 고도화',
      question: '기준을 바꿀까요?',
      status: 'pending',
      options: '[{"key":"a","label":"새 기준으로"},{"key":"b","label":"그대로"}]',
      recommend: 'a',
    },
    { id: 11, session_id: 's1', task_title: '정답지 고도화', question: '보류', status: 'held' },
    { id: 10, session_id: 's2', task_title: '', question: '남의 질문', status: 'pending' },
  ],
}

const snapshot = parseState(STATE, 's1', 1000)

test('the state is cut down to this session', () => {
  assert.deepEqual(snapshot.tasks.map(t => t.title), ['정답지 고도화', '문서 정리'])
  assert.equal(snapshot.tasks[1]?.number, 8)
  assert.deepEqual(snapshot.nodes.map(n => n.key), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(snapshot.nodes[1]?.after, ['a'])
  assert.deepEqual(snapshot.nodes[4]?.after, [])
  assert.deepEqual(snapshot.agents.map(a => a.id), ['g1', 'g2'])
  assert.deepEqual(snapshot.questions.map(q => q.id), [12, 14])
  assert.equal(snapshot.costUsd, 12.345)
  assert.equal(snapshot.nodes[2]?.owner, '검토자')
  assert.equal(snapshot.nodes[2]?.kind, '검토')
  assert.equal(snapshot.agents[0]?.updatedAt, 900)
  assert.deepEqual(snapshot.questions[0]?.options, [
    { key: 'a', label: '새 기준으로' },
    { key: 'b', label: '그대로' },
  ])
  assert.equal(snapshot.questions[0]?.recommend, 'a')
  assert.deepEqual(snapshot.questions[1]?.options, [])
  assert.equal(snapshot.fetchedAt, 1000)
})

test('a broken state reads as empty', () => {
  const empty = parseState('nope', 's1', 0, 'ko-KR')
  assert.deepEqual(empty, { tasks: [], nodes: [], agents: [], questions: [], costUsd: null, fetchedAt: 0, lang: 'ko' })
})

test('nodes are marked done, now, next, left and failed', () => {
  const nodes = snapshot.nodes
  assert.deepEqual(
    nodes.map(n => markOf(n, nodes)),
    ['✓', '●', '○', '▷', '✗'],
  )
})

test('a predecessor missing from the plan does not block', () => {
  const lone = { taskId: 1, key: 'x', title: 'x', kind: '', owner: '', status: '대기', after: ['gone'], round: 1 }
  assert.equal(markOf(lone, [lone]), '▷')
})

test('the progress bar fills by finished nodes', () => {
  assert.equal(progressBar(8, 10), '███░')
  assert.equal(progressBar(0, 0), '░░░░')
  assert.equal(progressBar(5, 5), '████')
  assert.equal(progressText(snapshot.nodes), '█░░░ 1/5')
})

test('counters and the subagent line', () => {
  const counts = countsOf(snapshot)
  assert.deepEqual(counts, { running: 1, completed: 1, waitingTasks: 1, decisions: 2 })
  assert.equal(countsLine(counts), '실행 1  끝남 1  작업 대기 1  결정 2')
  assert.equal(agentLine(snapshot.agents), '▸ 서브에이전트 2개 (끝난 1개 포함)')
  assert.equal(agentLine(snapshot.agents, true), '▾ 서브에이전트 2개 (끝난 1개 포함)')
  assert.deepEqual(
    countChips(counts).map(c => [c.label, c.color]),
    [
      ['실행 1', 'warning'],
      ['끝남 1', 'success'],
      ['작업 대기 1', 'suggestion'],
      ['결정 2', 'claude'],
    ],
  )
})

test('question lines name the task when there is one', () => {
  assert.equal(questionLine(snapshot.questions[0]!), 'Q12 [정답지 고도화] 기준을 바꿀까요?')
  assert.equal(questionLine(snapshot.questions[1]!), 'Q14 배포할까요?')
})

test('the recommended option reads in words', () => {
  assert.equal(recommendLine(snapshot.questions[0]!), '➡ (a) 새 기준으로')
  assert.equal(recommendLine(snapshot.questions[1]!), '')
  assert.equal(recommendLine({ ...snapshot.questions[0]!, recommend: 'z' }), '➡ (z)')
})

test('the header says why it last refreshed', () => {
  assert.equal(refreshText(3200, '턴 끝'), '마지막 갱신 3초 전 (턴 끝)')
  assert.equal(refreshText(0, ''), '마지막 갱신 0초 전')
})

test('cost and age read in Korean', () => {
  assert.equal(costText(2235.7), '세션 누적 $2235.70')
  assert.equal(costText(null), '')
  assert.equal(ageText(1500), '1초 전')
  assert.equal(ageText(125_000), '2분 전')
  assert.equal(ageText(7_300_000), '2시간 전')
})

test('Hangul takes two cells and truncation keeps to the width', () => {
  assert.equal(cells('가나 ab'), 7)
  assert.equal(truncate('정답지 고도화', 20), '정답지 고도화')
  const cut = truncate('정답지 고도화', 8)
  assert.equal(cut, '정답지…')
  assert.ok(cells(cut) <= 8)
  assert.equal(truncate('abc', 0), '')
})

test('a row gives the left text way first', () => {
  const [left, right] = splitRow('#12 정답지 고도화 작업', '███░ 8/10  하는 중', 30)
  assert.equal(right, '███░ 8/10  하는 중')
  assert.ok(cells(left) + 2 + cells(right) <= 30)
  assert.ok(left.endsWith('…'))
})

test('the local summary has a line per task and one for the session', () => {
  const lines = summaryLines(snapshot)
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /^#12 정답지 고도화: 작업 단계, 하는 중, 노드 1\/5 끝, 지금 고도화 구현, 다음 원문 읽기, 실패 배포$/)
  assert.equal(lines[2], '작업 2개, 결정 대기 2건, 서브에이전트 실행 1개, 끝남 1개')
})

function node(key: string, after: string[], status = '대기', extra: Partial<FlowNode> = {}): FlowNode {
  return { taskId: 1, key, title: key, kind: '구현', owner: '작업자', status, after, round: 1, ...extra }
}

test('nodes stand in columns by what they wait for, in plan order', () => {
  const plan = [node('a', []), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c']), node('e', [])]
  assert.deepEqual(
    columnsOf(plan).map(col => col.map(n => n.key)),
    [['a', 'e'], ['b', 'c'], ['d']],
  )
  // A loop or a missing predecessor adds no column.
  const loop = [node('x', ['y']), node('y', ['x']), node('z', ['gone'])]
  assert.equal(columnsOf(loop).flat().length, 3)
  assert.deepEqual(columnsOf([]), [])
})

test('the graph wraps its columns to the width', () => {
  const chain = [node('a', []), node('b', ['a']), node('c', ['b']), node('d', ['c'])]
  const wide = graphLayout(chain, 100)
  assert.deepEqual(wide.bands.map(b => b.length), [4])
  assert.equal(wide.boxCells, 22)
  const mid = graphLayout(chain, 58)
  assert.deepEqual(mid.bands.map(b => b.length), [2, 2])
  assert.equal(mid.boxCells, 26)
  assert.ok(mid.boxCells * 2 + 3 <= 58)
  const narrow = graphLayout(chain, 28)
  assert.deepEqual(narrow.bands.map(b => b.length), [1, 1, 1, 1])
  assert.ok(narrow.boxCells <= 28)
  assert.deepEqual(graphLayout([], 60).bands, [])
})

test('a node box holds kind and title, then owner and status', () => {
  const nodes = snapshot.nodes
  assert.deepEqual(nodeBox(nodes[0]!, nodes, 24), ['✓ 구현 IR 추출', '작업자, 끝'])
  assert.deepEqual(nodeBox(nodes[1]!, nodes, 24), ['● 구현 고도화 구현', '작업자, 지금, 2회차'])
  assert.deepEqual(nodeBox(nodes[2]!, nodes, 24), ['○ 검토 독립 검토', '검토자, 남음'])
  // Hangul counts two cells: a narrow box cuts the title.
  const [head] = nodeBox(nodes[1]!, nodes, 12)
  assert.ok(head.endsWith('…'))
  assert.ok(cells(head) <= 12)
})

test('a box border follows the status', () => {
  const nodes = snapshot.nodes
  assert.deepEqual(nodeTone(nodes[0]!, nodes), { color: 'success', borderStyle: 'round', isDim: false })
  assert.deepEqual(nodeTone(nodes[1]!, nodes), { color: 'claude', borderStyle: 'bold', isDim: false })
  assert.deepEqual(nodeTone(nodes[2]!, nodes), { color: 'inactive', borderStyle: 'dashed', isDim: true })
  assert.deepEqual(nodeTone(nodes[4]!, nodes), { color: 'error', borderStyle: 'round', isDim: false })
})

test('the plan says who drew it up', () => {
  assert.equal(plannerOf(snapshot.nodes), '오케스트레이터 계획')
  assert.equal(plannerOf([]), '')
  assert.equal(plannerOf([node('a', [], '대기', { owner: '사용자' })]), '')
  assert.equal(taskMeta(snapshot.tasks[0]!, snapshot.nodes), 'feat/x, PR #293, 오케스트레이터 계획')
  assert.equal(taskMeta(snapshot.tasks[1]!), '')
})

function agent(id: string, status: string, updatedAt: number): FlowAgent {
  return { id, taskTitle: 't', description: `[t::${id}] 일 ${id}`, status, updatedAt }
}

test('subagent rows drop the node prefix and keep running ones first', () => {
  assert.equal(agentTitle('[정답지 고도화::b] 검수'), '검수')
  assert.equal(agentTitle('추출'), '추출')
  assert.equal(agentTitle('[정답지 고도화::b]'), '[정답지 고도화::b]')
  assert.equal(agentStatusText('running'), '실행 중')
  assert.equal(agentStatusText('completed'), '끝')
  assert.equal(agentStatusText('odd'), 'odd')
  const agents = [agent('a', 'completed', 1), agent('b', 'running', 2), agent('c', 'completed', 3)]
  assert.deepEqual(agentRows(agents, false).map(a => a.id), ['b'])
  assert.deepEqual(agentRows(agents, true).map(a => a.id), ['b', 'c', 'a'])
  assert.deepEqual(agentRows(agents, true, 2).map(a => a.id), ['b', 'c'])
})

test('finished subagents wait on Claude until the main loop turns', () => {
  const done = [agent('a', 'completed', 500), agent('b', 'failed', 700)]
  assert.equal(isHandoff(done, { isBusy: false, since: 600 }), true)
  // The main loop runs, or has run since the last one ended.
  assert.equal(isHandoff(done, { isBusy: true, since: 600 }), false)
  assert.equal(isHandoff(done, { isBusy: false, since: 800 }), false)
  assert.equal(isHandoff([...done, agent('c', 'running', 900)], { isBusy: false, since: 0 }), false)
  assert.equal(isHandoff([], { isBusy: false, since: 0 }), false)
  assert.equal(HANDOFF_TEXT, '서브에이전트 끝, Claude가 넘길 차례')
})

test('a transcript reads as one line per step, the last ones kept', () => {
  const messages = [
    { role: 'user' as const, text: '시작하세요\n자세히', toolUses: [] },
    { role: 'assistant' as const, text: '읽겠습니다', toolUses: [{ tool: 'Read' }, { tool: 'Bash', isError: true as const }] },
    { role: 'user' as const, text: '결과', toolUses: [], toolResults: [{}] },
    { role: 'assistant' as const, text: '', toolUses: [] },
  ]
  assert.deepEqual(transcriptLines(messages), ['요청: 시작하세요 자세히', 'Claude: 읽겠습니다', '도구 Read', '도구 Bash (실패)'])
  assert.deepEqual(transcriptLines(messages, 2), ['도구 Read', '도구 Bash (실패)'])
})

test('the band names what runs and what waits, within the width', () => {
  assert.equal(bandText(snapshot, 200), '실행 중 1, 정답지 고도화: 재채점, 결정 대기 2')
  const many = {
    ...snapshot,
    tasks: [1, 2, 3].map(i => ({ ...snapshot.tasks[0]!, id: i, title: `작업 ${i}`, now: '고치는 중' })),
  }
  const line = bandText(many, 50)
  assert.ok(cells(line) <= 50)
  assert.match(line, /^실행 중 1, 작업 1: 고치는 중, 외 2, 결정 대기 2$/)
  const quiet = { ...snapshot, agents: [], questions: [], tasks: snapshot.tasks.map(t => ({ ...t, status: '대기' })) }
  assert.equal(bandText(quiet, 80), '')
  assert.equal(bandText({ ...quiet, questions: snapshot.questions }, 80), '결정 대기 2')
})

test('no dash or middle dot in what the pane shows', () => {
  const shown = [
    ...summaryLines(snapshot),
    countsLine(countsOf(snapshot)),
    agentLine(snapshot.agents),
    bandText(snapshot, 200),
    HANDOFF_TEXT,
    ...snapshot.nodes.flatMap(n => nodeBox(n, snapshot.nodes, 30)),
  ].join('\n')
  assert.doesNotMatch(shown, /[\u2014\u2013\u00b7]/)
})

test('/switchboard words map to the pane keys', () => {
  assert.equal(paneAction(''), 'open')
  assert.equal(paneAction(' 요약 '), 'summary')
  assert.equal(paneAction('y'), 'report')
  assert.equal(paneAction('갱신'), 'sync')
  assert.equal(paneAction('뭐지'), 'unknown')
})
