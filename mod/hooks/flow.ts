import type { FlowAgent, FlowNode, FlowOption, FlowQuestion, FlowTask, MainTurn, Snapshot } from '../types'
import { kindLabel, langOfState, osLocale, ownerLabel, stageLabel, t, taskStatusLabel, type Key, type Lang } from './i18n.ts'

// Pure helpers of the Switchboard pane: they read the bridge's /state and turn
// it into the lines the pane draws. Nothing here touches the engine.

export const MARKS = { done: '✓', now: '●', next: '▷', left: '○', failed: '✗' } as const

const MARK_KEYS: Record<string, Key> = {
  [MARKS.done]: 'mark.done',
  [MARKS.now]: 'mark.now',
  [MARKS.next]: 'mark.next',
  [MARKS.left]: 'mark.left',
  [MARKS.failed]: 'mark.failed',
}

export function legend(lang: Lang = 'ko'): string {
  return Object.entries(MARK_KEYS)
    .map(([mark, key]) => `${mark} ${t(lang, key)}`)
    .join('  ')
}

export const LEGEND = legend('ko')

type Raw = Record<string, unknown>

function rows(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter((r): r is Raw => r !== null && typeof r === 'object') : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

// The bridge's whole /state, cut down to this session's tasks, nodes,
// subagents and pending questions, and the language the app is set to.
export function parseState(raw: unknown, sessionId: string, fetchedAt: number, locale: string = osLocale()): Snapshot {
  const state = raw !== null && typeof raw === 'object' ? (raw as Raw) : {}
  const tasks: FlowTask[] = rows(state.tasks)
    .filter(t => t.session_id === sessionId)
    .map(t => ({
      id: num(t.id),
      number: num(t.number, num(t.id)),
      title: text(t.title),
      stage: text(t.stage),
      status: text(t.status),
      now: text(t.now),
      branch: text(t.branch),
      artifact: text(t.artifact),
    }))
  const ids = new Set(tasks.map(t => t.id))
  const nodes: FlowNode[] = rows(state.nodes)
    .filter(n => ids.has(num(n.task_id)))
    .map(n => {
      const after = json(n.after)
      return {
        taskId: num(n.task_id),
        key: text(n.key),
        title: text(n.title),
        status: text(n.status),
        kind: text(n.kind),
        owner: text(n.owner),
        after: Array.isArray(after) ? after.filter((k): k is string => typeof k === 'string') : [],
        round: num(n.round, 1),
      }
    })
  const agents: FlowAgent[] = rows(state.agents)
    .filter(a => a.session_id === sessionId)
    .map(a => ({
      id: text(a.id),
      taskTitle: text(a.task_title),
      description: text(a.description),
      status: text(a.status),
      updatedAt: num(a.updated_at),
    }))
  const questions: FlowQuestion[] = rows(state.questions)
    .filter(q => q.session_id === sessionId && q.status === 'pending')
    .map(q => ({
      id: num(q.id),
      taskTitle: text(q.task_title),
      question: text(q.question),
      options: rows(json(q.options)).map((o): FlowOption => ({ key: text(o.key), label: text(o.label) })),
      recommend: text(q.recommend),
    }))
    .sort((a, b) => a.id - b.id)
  const session = rows(state.sessions).find(s => s.id === sessionId)
  const usage = json(session?.usage) as { cost?: { totalUsd?: unknown } } | undefined
  const cost = usage?.cost?.totalUsd
  return { tasks, nodes, agents, questions, costUsd: typeof cost === 'number' ? cost : null, fetchedAt, lang: langOfState(raw, locale) }
}

export type Counts = { running: number; completed: number; waitingTasks: number; decisions: number }

export function countsOf(snapshot: Snapshot): Counts {
  return {
    running: snapshot.agents.filter(a => a.status === 'running').length,
    completed: snapshot.agents.filter(a => a.status === 'completed').length,
    waitingTasks: snapshot.tasks.filter(t => t.status === '대기').length,
    decisions: snapshot.questions.length,
  }
}

// The counters as chips, each in the color of what it counts.
export function countChips(counts: Counts, lang: Lang = 'ko'): { key: string; label: string; color: string }[] {
  return [
    { key: 'running', label: t(lang, 'chip.running', { n: counts.running }), color: 'warning' },
    { key: 'completed', label: t(lang, 'chip.completed', { n: counts.completed }), color: 'success' },
    { key: 'waiting', label: t(lang, 'chip.waiting', { n: counts.waitingTasks }), color: 'suggestion' },
    { key: 'decisions', label: t(lang, 'chip.decisions', { n: counts.decisions }), color: 'claude' },
  ]
}

export function countsLine(counts: Counts, lang: Lang = 'ko'): string {
  return countChips(counts, lang)
    .map(chip => chip.label)
    .join('  ')
}

export function nodesOf(snapshot: Snapshot, task: FlowTask): FlowNode[] {
  return snapshot.nodes.filter(n => n.taskId === task.id)
}

export function agentsOf(snapshot: Snapshot, task: FlowTask): FlowAgent[] {
  return snapshot.agents.filter(a => a.taskTitle === task.title)
}

// A waiting node is next once every node it waits for has finished; a
// predecessor the plan does not hold does not block it.
export function markOf(node: FlowNode, nodes: readonly FlowNode[]): string {
  if (node.status === '끝') return MARKS.done
  if (node.status === '지금') return MARKS.now
  if (node.status === '실패') return MARKS.failed
  const isReady = node.after.every(key => {
    const before = nodes.find(n => n.key === key)
    return before === undefined || before.status === '끝'
  })
  return isReady ? MARKS.next : MARKS.left
}

export function progressBar(done: number, total: number, cells = 4): string {
  const filled = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function progressText(nodes: readonly FlowNode[]): string {
  const done = nodes.filter(n => n.status === '끝').length
  return `${progressBar(done, nodes.length)} ${done}/${nodes.length}`
}

export function agentLine(agents: readonly FlowAgent[], isOpen = false, lang: Lang = 'ko'): string {
  const done = agents.filter(a => a.status !== 'running').length
  return `${isOpen ? '▾' : '▸'} ${t(lang, 'flow.agents', { n: agents.length, done })}`
}

export function questionLine(q: FlowQuestion): string {
  return q.taskTitle ? `Q${q.id} [${q.taskTitle}] ${q.question}` : `Q${q.id} ${q.question}`
}

// The recommended option by its words, not its key alone.
export function recommendLine(q: FlowQuestion): string {
  if (!q.recommend) return ''
  const label = q.options.find(o => o.key === q.recommend)?.label ?? ''
  return label ? `➡ (${q.recommend}) ${label}` : `➡ (${q.recommend})`
}

export function taskHead(task: FlowTask): string {
  return `#${task.number} ${task.title}`
}

export function taskMeta(task: FlowTask, nodes: readonly FlowNode[] = [], lang: Lang = 'ko'): string {
  return [task.branch, task.artifact, plannerOf(nodes, lang)].filter(Boolean).join(', ')
}

// Who laid out the plan. plan_nodes is the session's own tool, so a plan that
// hands work to workers or reviewers was drawn up by the session as their
// orchestrator; a plan of the person's steps alone says nothing about that.
export function plannerOf(nodes: readonly FlowNode[], lang: Lang = 'ko'): string {
  return nodes.some(n => n.owner && n.owner !== '사용자') ? t(lang, 'flow.planner') : ''
}

export function costText(usd: number | null, lang: Lang = 'ko'): string {
  return usd === null ? '' : t(lang, 'flow.cost', { usd: usd.toFixed(2) })
}

// `reason` comes already in words.
export function refreshText(ms: number, reason: string, lang: Lang = 'ko'): string {
  const age = ageText(ms, lang)
  return reason ? t(lang, 'flow.refreshedWhy', { age, reason }) : t(lang, 'flow.refreshed', { age })
}

export function ageText(ms: number, lang: Lang = 'ko'): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return t(lang, 'age.seconds', { n: seconds })
  if (seconds < 3600) return t(lang, 'age.minutes', { n: Math.floor(seconds / 60) })
  return t(lang, 'age.hours', { n: Math.floor(seconds / 3600) })
}

// Terminal cells a character takes: Hangul, CJK and full-width forms take two.
function charCells(code: number): number {
  if (code < 0x1100) return 1
  if (
    code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function cells(value: string): number {
  let width = 0
  for (const ch of value) width += charCells(ch.codePointAt(0) ?? 0)
  return width
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return ''
  if (cells(value) <= width) return value
  let out = ''
  let used = 0
  for (const ch of value) {
    const w = charCells(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out.trimEnd()}…`
}

// A left text and a right text on one row of `width` cells: the left one
// gives way first, the right one only when it alone is too wide.
export function splitRow(left: string, right: string, width: number): [string, string] {
  if (!right) return [truncate(left, width), '']
  const rightFit = truncate(right, width)
  const room = width - cells(rightFit) - 2
  return [room > 0 ? truncate(left, room) : '', rightFit]
}

// The p key's local summary: one line per task and one for the session, read
// from the bridge snapshot alone, no model call.
export function summaryLines(snapshot: Snapshot, lang: Lang = 'ko'): string[] {
  const sep = t(lang, 'sep')
  const lines = snapshot.tasks.map(task => {
    const nodes = nodesOf(snapshot, task)
    const done = nodes.filter(n => n.status === '끝').length
    const stage = stageLabel(lang, task.stage)
    const parts = [t(lang, 'summary.task', { head: taskHead(task), stage, status: taskStatusLabel(lang, task.status) })]
    if (nodes.length > 0) parts.push(t(lang, 'summary.nodes', { done, total: nodes.length }))
    const now = nodes.filter(n => n.status === '지금').map(n => n.title)
    if (now.length > 0) parts.push(t(lang, 'summary.now', { titles: now.join(sep) }))
    const next = nodes.filter(n => markOf(n, nodes) === MARKS.next).map(n => n.title)
    if (next.length > 0) parts.push(t(lang, 'summary.next', { titles: next.join(sep) }))
    const failed = nodes.filter(n => n.status === '실패').map(n => n.title)
    if (failed.length > 0) parts.push(t(lang, 'summary.failed', { titles: failed.join(sep) }))
    return parts.join(sep)
  })
  const counts = countsOf(snapshot)
  lines.push(
    t(lang, 'summary.total', {
      tasks: snapshot.tasks.length,
      decisions: counts.decisions,
      running: counts.running,
      completed: counts.completed,
    }),
  )
  return lines
}

// Plan columns: a node stands one column right of the furthest node it waits
// for, so every arrow points right; inside a column the plan's order holds.
export function columnsOf(nodes: readonly FlowNode[]): FlowNode[][] {
  const depth = new Map<string, number>()
  const depthOf = (node: FlowNode, seen: ReadonlySet<string>): number => {
    const known = depth.get(node.key)
    if (known !== undefined) return known
    let d = 0
    for (const key of node.after) {
      const before = nodes.find(n => n.key === key)
      // A missing predecessor or a loop in the plan adds no column.
      if (before && !seen.has(before.key)) d = Math.max(d, depthOf(before, new Set([...seen, node.key])) + 1)
    }
    depth.set(node.key, d)
    return d
  }
  const columns: FlowNode[][] = []
  for (const node of nodes) {
    const d = depthOf(node, new Set([node.key]))
    while (columns.length <= d) columns.push([])
    columns[d]!.push(node)
  }
  return columns
}

export const ARROW_CELLS = 3
const BOX_MIN = 20
const BOX_MAX = 26

export type GraphLayout = { boxCells: number; bands: FlowNode[][][] }

// Columns side by side as many as the width holds, the rest wrapped into
// bands below; a box is as wide as the room allows, between 20 and 26 cells.
export function graphLayout(nodes: readonly FlowNode[], width: number): GraphLayout {
  const columns = columnsOf(nodes)
  if (columns.length === 0) return { boxCells: 0, bands: [] }
  const fit = Math.max(1, Math.floor((width + ARROW_CELLS) / (BOX_MIN + ARROW_CELLS)))
  const perBand = Math.min(fit, columns.length)
  const boxCells = Math.max(4, Math.min(BOX_MAX, Math.floor((width - ARROW_CELLS * (perBand - 1)) / perBand)))
  const bands: FlowNode[][][] = []
  for (let i = 0; i < columns.length; i += perBand) bands.push(columns.slice(i, i + perBand))
  return { boxCells, bands }
}

// A node's box: its kind and title, then who owns it and where it stands.
export function nodeBox(node: FlowNode, nodes: readonly FlowNode[], inner: number, lang: Lang = 'ko'): [string, string] {
  const mark = markOf(node, nodes)
  const head = [mark, kindLabel(lang, node.kind), node.title].filter(Boolean).join(' ')
  const word = MARK_KEYS[mark] ? t(lang, MARK_KEYS[mark]) : ''
  const round = node.round > 1 ? t(lang, 'flow.round', { n: node.round }) : ''
  const foot = [ownerLabel(lang, node.owner), word, round].filter(Boolean).join(t(lang, 'sep'))
  return [truncate(head, inner), truncate(foot, inner)]
}

export type BoxTone = { color: string; borderStyle: 'round' | 'bold' | 'dashed'; isDim: boolean }

export function nodeTone(node: FlowNode, nodes: readonly FlowNode[]): BoxTone {
  const mark = markOf(node, nodes)
  if (mark === MARKS.done) return { color: 'success', borderStyle: 'round', isDim: false }
  if (mark === MARKS.now) return { color: 'claude', borderStyle: 'bold', isDim: false }
  if (mark === MARKS.failed) return { color: 'error', borderStyle: 'round', isDim: false }
  return { color: 'inactive', borderStyle: 'dashed', isDim: true }
}

// "[task::node] what to do" ties a subagent to its node; the row needs the
// words after it.
export function agentTitle(description: string): string {
  return description.replace(/^\[[^\]]+?::[^\]]+?\]\s*/, '') || description
}

const AGENT_STATUS: Record<string, Key> = {
  running: 'agent.running',
  completed: 'agent.completed',
  failed: 'agent.failed',
  killed: 'agent.killed',
  stopped: 'agent.stopped',
  paused: 'agent.paused',
}

export function agentStatusText(status: string, lang: Lang = 'ko'): string {
  const key = Object.hasOwn(AGENT_STATUS, status) ? AGENT_STATUS[status] : undefined
  return key ? t(lang, key) : status
}

export function isAgentDone(agent: FlowAgent): boolean {
  return agent.status !== 'running' && agent.status !== 'paused'
}

// Running ones first, then the latest; at most `max`.
export function agentRows(agents: readonly FlowAgent[], isOpen: boolean, max = 10): FlowAgent[] {
  const running = agents.filter(a => !isAgentDone(a))
  if (!isOpen) return running
  const done = agents.filter(isAgentDone).sort((a, b) => b.updatedAt - a.updatedAt)
  return [...running, ...done].slice(0, max)
}

// Every subagent of the task has ended, the last after the main loop's own
// turn last started or ended, and the main loop idles: Claude has yet to pick
// up their results.
export function isHandoff(agents: readonly FlowAgent[], turn: MainTurn): boolean {
  if (agents.length === 0 || turn.isBusy || !agents.every(isAgentDone)) return false
  return Math.max(...agents.map(a => a.updatedAt)) > turn.since
}

export const HANDOFF_TEXT = t('ko', 'flow.handoff')

type TranscriptMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; isError?: true }[]
  toolResults?: readonly unknown[]
}

function oneLine(value: string, max = 300): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

// The last `max` steps of a subagent's transcript, one line each.
export function transcriptLines(messages: readonly TranscriptMessage[], max = 12, lang: Lang = 'ko'): string[] {
  const out: string[] = []
  for (const m of messages) {
    const said = oneLine(m.text)
    if (m.role === 'assistant') {
      if (said) out.push(t(lang, 'tr.claude', { text: said }))
      for (const use of m.toolUses) out.push(t(lang, use.isError ? 'tr.toolFailed' : 'tr.tool', { tool: use.tool }))
    } else if (said && !(m.toolResults && m.toolResults.length > 0)) {
      out.push(t(lang, 'tr.request', { text: said }))
    }
  }
  return out.slice(-max)
}

// The band above the prompt: what runs and what waits for the person, in one
// line of `width` cells; '' when nothing runs and nothing waits.
export function bandText(snapshot: Snapshot, width: number, lang: Lang = 'ko'): string {
  const running = snapshot.agents.filter(a => a.status === 'running').length
  const busy = snapshot.tasks.filter(t => t.status === '하는 중' && t.now)
  const decisions = snapshot.questions.length
  if (running === 0 && busy.length === 0 && decisions === 0) return ''
  const head = running > 0 || busy.length > 0 ? t(lang, 'band.running', { n: running }) : ''
  const tail = decisions > 0 ? t(lang, 'band.decisions', { n: decisions }) : ''
  const itemCells = Math.max(12, Math.floor(width / 2))
  const items = busy.map(t => truncate(`${t.title}: ${t.now}`, itemCells))
  for (let shown = items.length; shown >= 0; shown--) {
    const rest = items.length - shown
    const more = rest > 0 ? t(lang, 'band.more', { n: rest }) : ''
    const line = [head, ...items.slice(0, shown), more, tail].filter(Boolean).join(t(lang, 'sep'))
    if (cells(line) <= width || shown === 0) return truncate(line, width)
  }
  return ''
}

// What `/switchboard <args>` does, so the pane's p, y and g also work from the
// prompt, where a bare "p:" is only text for Claude. Each UI language's words work.
export type PaneAction = 'open' | 'summary' | 'report' | 'sync' | 'unknown'

export function paneAction(args: string): PaneAction {
  const word = args.trim().toLowerCase()
  if (word === '') return 'open'
  if (['p', '요약', 'summary', '要約', '摘要'].includes(word)) return 'summary'
  if (['y', '보고', 'report', '報告', '报告'].includes(word)) return 'report'
  if (['g', '갱신', 'sync', '更新', '同步'].includes(word)) return 'sync'
  return 'unknown'
}
