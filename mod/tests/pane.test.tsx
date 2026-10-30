import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { toolDefs } from '../hooks/tools.ts'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'ide-bridge',
  component: 'Pane',
  requestId: 'claude-ide',
  props: {
    title: 'Switchboard',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The language is set, so the pane reads Korean whatever the machine's locale.
const STATE = {
  settings: { lang: 'ko' },
  sessions: [{ id: 's1', project: 'p', usage: JSON.stringify({ cost: { totalUsd: 9.99 } }) }],
  tasks: [
    {
      id: 7,
      session_id: 's1',
      title: '산방서 DocumentIR 정답지 고도화',
      stage: '작업',
      status: '하는 중',
      now: '작업자 주석 고친 뒤 AI 검수 재채점',
      number: 12,
      branch: 'feat/calc-edit-integration',
      artifact: 'PR #293',
    },
    { id: 8, session_id: 's1', title: '문서 정리', stage: '요구', status: '대기', now: '', number: 13, branch: '', artifact: '' },
    { id: 9, session_id: 'other', title: '다른 세션의 작업', stage: '작업', status: '하는 중', now: '', number: 9 },
  ],
  nodes: [
    { task_id: 7, key: 'ir', title: 'IR 추출', kind: '구현', owner: '작업자', status: '끝', after: '[]', round: 1 },
    { task_id: 7, key: 'read', title: '원문 읽기', kind: '확인', owner: '작업자', status: '끝', after: '["ir"]', round: 1 },
    { task_id: 7, key: 'impl', title: '고도화 구현', kind: '구현', owner: '작업자', status: '지금', after: '["read"]', round: 2 },
    { task_id: 7, key: 'review', title: '독립 검토', kind: '검토', owner: '검토자', status: '대기', after: '["impl"]', round: 1 },
  ],
  agents: [
    {
      id: 'a1',
      session_id: 's1',
      task_title: '산방서 DocumentIR 정답지 고도화',
      description: '[산방서 DocumentIR 정답지 고도화::impl] AI 검수 재채점',
      status: 'running',
      updated_at: 99_000,
    },
    {
      id: 'a2',
      session_id: 's1',
      task_title: '산방서 DocumentIR 정답지 고도화',
      description: '[산방서 DocumentIR 정답지 고도화::ir] IR 추출',
      status: 'completed',
      updated_at: 95_000,
    },
  ],
  questions: [
    {
      id: 12,
      session_id: 's1',
      task_title: '문서 정리',
      question: '목차를 바꿀까요?',
      status: 'pending',
      options: JSON.stringify([
        { key: 'a', label: '장 순서대로' },
        { key: 'b', label: '그대로 둠' },
      ]),
      recommend: 'a',
    },
    { id: 13, session_id: 'other', task_title: '', question: '남의 질문', status: 'pending' },
  ],
  events: [],
}

type World = {
  fetches: string[]
  sockets: string[]
  prompts: string[]
  // Descriptions of the tools and commands the mod registered.
  described: string[]
  isDown: boolean
  isPlaced: boolean
  isOpen: boolean
  state: unknown
}

// Everything beneath the plugin: the engine's answers to the calls the mod
// makes, and a bridge that answers /state until the test takes it down.
function world(on: On, state: unknown = STATE): World {
  const w: World = { fetches: [], sockets: [], prompts: [], described: [], isDown: false, isPlaced: true, isOpen: false, state }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 2235.7 } } }))
  on('process.run', (_, e) => ({
    value: {
      // printenv answers HOME; the bridge start script fails, so register.ts
      // keeps no subscription open in the test.
      exitCode: e.argv[0] === 'printenv' ? 0 : 1,
      stdout: e.argv[0] === 'printenv' ? '/home/t\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', (_, e) => {
    w.fetches.push(e.url)
    w.sockets.push(e.init?.socketPath ?? '')
    if (w.isDown) throw new Error('ECONNREFUSED')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(w.state) } }
  })
  on('tool.register', (_, e) => {
    w.described.push(e.description ?? '')
    return { value: { tool: e.name } }
  })
  on('command.register', (_, e) => {
    w.described.push(e.description ?? '')
    return { value: { command: e.name } }
  })
  on('ui.open', () => {
    w.isOpen = true
    return { value: w.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: '80 columns, under 144' } }
  })
  on('ui.panes', () => ({
    value: w.isOpen
      ? [{ id: 'claude-ide', title: 'Switchboard', isShown: w.isPlaced, isFocused: false, isPlaced: w.isPlaced }]
      : [],
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'IR을 추출하세요', toolUses: [] },
      { role: 'assistant' as const, text: '추출을 시작합니다', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] },
      { role: 'assistant' as const, text: '추출을 끝냈습니다', toolUses: [] },
    ],
  }))
  // Stands for the engine's own drawing, which the band passes to.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  return w
}

test('the pane shows this session\'s flow, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.fetches).toContain('http://bridge/state')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /세션 누적/ }))?.text).toBe('세션 누적 $2235.70')
    expect(await ui.find({ type: 'Text', text: /마지막 갱신 0초 전/ })).toBeDefined()
    expect((await ui.find({ key: 'tab-flow' }))?.text).toBe('1: 흐름 2')
    expect((await ui.find({ key: 'tab-decisions' }))?.text).toBe('2: 결정 대기 1')
    for (const [label, color] of [
      [' 실행 1 ', 'warning'],
      [' 끝남 1 ', 'success'],
      [' 작업 대기 1 ', 'suggestion'],
      [' 결정 1 ', 'claude'],
    ] as const) {
      expect((await ui.find({ type: 'Text', text: label }))?.props.backgroundColor).toBe(color)
    }
    expect((await ui.find({ type: 'Text', text: /^#12/ }))?.text).toBe('#12 산방서 DocumentIR 정답지 고도화')
    expect((await ui.find({ type: 'Text', text: /2\/4/ }))?.text).toBe('██░░ 2/4  하는 중')
    expect(await ui.find({ type: 'Text', text: 'feat/calc-edit-integration, PR #293, 오케스트레이터 계획' })).toBeDefined()
    // A box per node: kind and title, then owner and where it stands.
    expect(await ui.find({ type: 'Text', text: '✓ 구현 IR 추출' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ 확인 원문 읽기' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '작업자, 지금, 2회차' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '검토자, 남음' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '작업자 주석 고친 뒤 AI 검수 재채점' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '실행 중' })).toBeDefined()
    expect((await ui.find({ key: 'agents-7' }))?.text).toBe('▸ 서브에이전트 2개 (끝난 1개 포함)')
    // Folded, the list keeps the running one, its node prefix left out.
    expect(await ui.find({ type: 'Text', text: '● AI 검수 재채점' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /IR 추출$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ IR 추출' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /다른 세션/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('keys 1 and 2 switch tabs, p toggles the local summary', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-decisions' })
    expect((await ui.find({ type: 'Text', text: /^Q12/ }))?.text).toBe('Q12 [문서 정리] 목차를 바꿀까요?')
    expect(await ui.find({ type: 'Text', text: /남의 질문/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^#12/ })).toBeUndefined()

    await ui.press({ key: 'tab-flow' })
    expect(await ui.find({ type: 'Text', text: /^#12/ })).toBeDefined()

    await ui.press({ key: 'summary' })
    expect(await ui.find({ type: 'Text', text: /노드 2\/4 끝, 지금 고도화 구현/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '작업 2개, 결정 대기 1건, 서브에이전트 실행 1개, 끝남 1개' })).toBeDefined()
    await ui.press({ key: 'summary' })
    expect(await ui.find({ type: 'Text', text: /노드 2\/4 끝/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('y and g ask Claude through a prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'report' })
  await ui.press({ key: 'sync' })
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[0]).toMatch(/진행 보고/)
  expect(w.prompts[1]).toMatch(/set_task/)
  expect(w.prompts[1]).toMatch(/plan_nodes/)
  expect(w.prompts[1]).toMatch(/update_node/)
  expect(w.prompts.join('\n')).not.toMatch(/[\u2014\u2013\u00b7]/)
  await ui.unmount()
})

test('a lost bridge keeps the last data and says so', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  w.isDown = true
  await clock.advance(3000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /브리지 연결 안 됨/ }))?.text).toBe('브리지 연결 안 됨, 마지막 갱신 3초 전 (자동)')
    expect(await ui.find({ type: 'Text', text: /^#12/ })).toBeDefined()
    await ui.unmount()
  }

  w.isDown = false
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /브리지 연결 안 됨/ })).toBeUndefined()
  await ui.unmount()
})

test('nothing is fetched while the pane waits undrawn', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  w.isPlaced = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // The session start reads the language once; the poll adds nothing after it.
  const atStart = w.fetches.filter(url => url.endsWith('/state')).length
  await clock.advance(9000)
  expect(w.fetches.filter(url => url.endsWith('/state')).length).toBe(atStart)

  w.isPlaced = true
  await clock.advance(3000)
  expect(w.fetches.filter(url => url.endsWith('/state')).length).toBe(atStart + 1)
})

test('a narrow pane cuts titles to its width', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 30 } })
    const head = await ui.find({ type: 'Text', text: /^#12/ })
    expect(head?.text.endsWith('…')).toBe(true)
    const meta = await ui.find({ type: 'Text', text: /^feat\// })
    expect(meta?.text.endsWith('…')).toBe(true)
    await ui.unmount()
  }
})

test('/switchboard opens the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ran = await $.command.run({
    command: 'switchboard',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect(ran.text).toBe('Switchboard 창을 열었습니다.')
})

test('before the first answer the pane says it is loading', async ($, on) => {
  mock.clock(on, { now: 100_000 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '브리지에서 불러오는 중' })).toBeDefined()
    expect((await ui.find({ key: 'tab-flow' }))?.text).toBe('1: 흐름 0')
    await ui.unmount()
  }
})


const BAND = {
  plugin: 'ide-bridge',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const TURN_END = { turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('node boxes take their border from the status', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const boxes = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle !== undefined)
    const border = (title: RegExp) => {
      const box = boxes.find(b => title.test(b.text))
      return [box?.props.borderStyle, box?.props.borderColor, box?.props.borderDimColor]
    }
    expect(boxes.length).toBe(4)
    expect(border(/IR 추출/)).toEqual(['round', 'success', false])
    expect(border(/고도화 구현/)).toEqual(['bold', 'claude', false])
    expect(border(/독립 검토/)).toEqual(['dashed', 'inactive', true])
    await ui.unmount()
  }
})

test('r refreshes at once and the header says why', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '마지막 갱신 0초 전 (창 열림)' })).toBeDefined()
  const before = w.fetches.length
  await ui.press({ key: 'refresh' })
  expect(w.fetches.length).toBe(before + 1)
  expect(await ui.find({ type: 'Text', text: '마지막 갱신 0초 전 (r 키)' })).toBeDefined()
  await ui.unmount()
})

test('the main turn refreshes at its start and its end', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let before = w.fetches.filter(url => url.endsWith('/state')).length
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  expect(w.fetches.filter(url => url.endsWith('/state')).length).toBe(before + 1)
  expect(await ui.find({ type: 'Text', text: /\(턴 시작\)$/ })).toBeDefined()

  before = w.fetches.filter(url => url.endsWith('/state')).length
  await $.turn.complete(TURN_END)
  await clock.settle()
  expect(w.fetches.filter(url => url.endsWith('/state')).length).toBe(before + 1)
  expect(await ui.find({ type: 'Text', text: /\(턴 끝\)$/ })).toBeDefined()
  await ui.unmount()
})

test('the subagent list folds open and shows a transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'agents-7' })
    expect((await ui.find({ key: 'agents-7' }))?.text).toBe('▾ 서브에이전트 2개 (끝난 1개 포함)')
    expect(await ui.find({ type: 'Text', text: '○ IR 추출' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '끝' })).toBeDefined()

    await ui.press({ key: 'open-a2' })
    expect(await ui.find({ type: 'Text', text: '요청: IR을 추출하세요' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '도구 Read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude: 추출을 끝냈습니다' })).toBeDefined()
    await ui.press({ key: 'open-a2' })
    expect(await ui.find({ type: 'Text', text: 'Claude: 추출을 끝냈습니다' })).toBeUndefined()

    await ui.press({ key: 'agents-7' })
    expect(await ui.find({ type: 'Text', text: '○ IR 추출' })).toBeUndefined()
    await ui.unmount()
  }
})

test('finished subagents wait on Claude until the main loop takes its turn', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const done = { ...STATE, agents: STATE.agents.map(a => ({ ...a, status: 'completed', updated_at: 150_000 })) }
  world(on, done)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const handoff = '● 서브에이전트 끝, Claude가 넘길 차례'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: handoff })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.start({ text: 'go', turnId: 't1' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: handoff })).toBeUndefined()
  await ui.unmount()

  await clock.advance(100_000)
  await $.turn.complete(TURN_END)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: handoff })).toBeUndefined()
  await ui.unmount()
})

test('a question shows its recommended option in words', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-decisions' })
    expect(await ui.find({ type: 'Text', text: '➡ (a) 장 순서대로' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band above the prompt says what runs and what waits', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /^실행 중/ })
    expect(line?.text).toBe('실행 중 1, 산방서 DocumentIR 정답지 고도화: 작업자 주석 고친…, 결정 대기 1')
    expect(line?.props.color).toBe('warning')
    await ui.unmount()

    const survey = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey: true } })
    expect(await survey.find({ type: 'Text', text: /^실행 중/ })).toBeUndefined()
    expect(await survey.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await survey.unmount()
  }
})

test('the band stays empty when nothing runs and nothing waits', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const quiet = {
    ...STATE,
    tasks: STATE.tasks.map(t => ({ ...t, status: '대기' })),
    agents: STATE.agents.map(a => ({ ...a, status: 'completed' })),
    questions: [],
  }
  world(on, quiet)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /실행 중/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

test('the bridge socket comes from CLAUDE_IDE_SOCKET when set', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_IDE_SOCKET' ? '/tmp/cide/bridge.sock' : undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.sockets[w.fetches.indexOf('http://bridge/state')]).toBe('/tmp/cide/bridge.sock')
})

test('without CLAUDE_IDE_SOCKET the socket is the one under HOME', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on)
  on('env.get', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.sockets[w.fetches.indexOf('http://bridge/state')]).toBe('/home/t/.claude-ide/bridge.sock')
})

test('with lang set to en, the pane, band, prompts and command speak English', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const w = world(on, { ...STATE, settings: { lang: 'en' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Session total/ }))?.text).toBe('Session total $2235.70')
    expect(await ui.find({ type: 'Text', text: 'Updated 0s ago (pane opened)' })).toBeDefined()
    expect((await ui.find({ key: 'tab-flow' }))?.text).toBe('1: Flow 2')
    expect((await ui.find({ key: 'tab-decisions' }))?.text).toBe('2: Decisions 1')
    for (const label of [' Running 1 ', ' Done 1 ', ' Waiting 1 ', ' Decisions 1 ']) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    }
    expect((await ui.find({ type: 'Text', text: /2\/4/ }))?.text).toBe('██░░ 2/4  Active')
    expect(await ui.find({ type: 'Text', text: 'feat/calc-edit-integration, PR #293, Orchestrator plan' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ Build IR 추출' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Worker, now, round 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Reviewer, left' })).toBeDefined()
    expect((await ui.find({ key: 'agents-7' }))?.text).toBe('▸ 2 subagents (1 done)')
    expect((await ui.find({ key: 'summary' }))?.text).toBe('Summary (p)')
    expect(await ui.find({ type: 'Text', text: /^Flow by task/ })).toBeDefined()

    await ui.press({ key: 'summary' })
    expect(await ui.find({ type: 'Text', text: /: Work stage, Active, 2\/4 nodes done, now 고도화 구현/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 tasks, 1 decision waiting, 1 subagent running, 1 done' })).toBeDefined()
    await ui.press({ key: 'summary' })

    await ui.press({ key: 'tab-decisions' })
    expect(await ui.find({ type: 'Text', text: '➡ (a) 장 순서대로' })).toBeDefined()
    await ui.press({ key: 'tab-flow' })
    expect(await ui.find({ type: 'Text', text: /[\uac00-\ud7a3]{2,} [0-9]/ })).toBeUndefined()
    await ui.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^Running/ }))?.text).toMatch(/^Running 1, .*, Decisions waiting 1$/)
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'report' })
  expect(w.prompts[0]).toMatch(/^\[Switchboard\] Please give a progress report/)
  await ui.unmount()

  const ran = await $.command.run({
    command: 'switchboard',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect(ran.text).toBe('Opened the Switchboard pane.')
  // The tools of register.ts (toolDefs), open_in_ide and the /switchboard command.
  expect(w.described.length).toBe(toolDefs('en').length + 2)
  expect(w.described.some(d => d.startsWith('Opens the Switchboard pane'))).toBe(true)
  // English all through, but for the Korean enum values the tools take.
  const enums = /오케스트레이터|작업자|검토자|사용자|하는 중|요구|설계|작업|완료|대기|보관|지금|끝|실패|시험|확인|구현|검토|기타/g
  for (const description of w.described) expect(description.replace(enums, '')).not.toMatch(/[\uac00-\ud7a3]/)
  expect([...w.described, ...w.prompts].join('\n')).not.toMatch(/[\u2014\u2013\u00b7]/)
})

test('without a language setting, the bridge reached, the pane follows the machine locale', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const { settings: _, ...unset } = STATE
  world(on, unset)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tab = (await ui.find({ key: 'tab-flow' }))?.text
  expect(['1: 흐름 2', '1: Flow 2', '1: 流れ 2', '1: 流程 2']).toContain(tab)
  await ui.unmount()
})
