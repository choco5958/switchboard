import type { GraphNode, Option, Question, Session, Task } from '../../shared/types'
import { agoText } from '../../shared/i18n'

export const STAGES = ['요구', '설계', '작업', '완료'] as const

export function optionsOf(q: Question): Option[] {
  try {
    const parsed: unknown = JSON.parse(q.options)
    return Array.isArray(parsed) ? (parsed as Option[]) : []
  } catch {
    return []
  }
}

// Oldest pending first (they have waited longest), held ones after.
export function queueOf(questions: Question[]): { pending: Question[]; held: Question[] } {
  const byAge = (a: Question, b: Question) => a.id - b.id
  return {
    pending: questions.filter(q => q.status === 'pending').sort(byAge),
    held: questions.filter(q => q.status === 'held').sort(byAge),
  }
}

// After the current question leaves the queue, select the next one in line.
export function nextAfter(questions: Question[], currentId: number | null): number | null {
  const { pending } = queueOf(questions)
  const open = pending.filter(q => q.id !== currentId)
  if (open.length === 0) return null
  return (open.find(q => currentId !== null && q.id > currentId) ?? open[0])?.id ?? null
}

export function tasksByProject(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    const list = groups.get(task.project) ?? []
    list.push(task)
    groups.set(task.project, list)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export type KeyAction =
  | { type: 'choose'; key: string }
  | { type: 'send' }
  | { type: 'hold' }
  | { type: 'memo' }
  | { type: 'none' }

// Keys while the question card has focus (not while typing in the memo):
// an option's own key or its 1-based number picks it, Enter sends, h holds, m opens the memo.
export function keyAction(key: string, options: Option[]): KeyAction {
  const lower = key.toLowerCase()
  if (key === 'Enter') return { type: 'send' }
  const byKey = options.find(o => o.key.toLowerCase() === lower)
  if (byKey) return { type: 'choose', key: byKey.key }
  if (/^[1-9]$/.test(key)) {
    const byNumber = options.at(Number(key) - 1)
    if (byNumber) return { type: 'choose', key: byNumber.key }
  }
  if (lower === 'h') return { type: 'hold' }
  if (lower === 'm') return { type: 'memo' }
  return { type: 'none' }
}

// The keys that really pick each option, as keyAction reads them: its own key when that is one
// character, then its number while no option's own key takes that digit first. A key two options
// claim goes to the first, so the second does not list it.
export function optionKeys(options: Option[]): Map<string, string[]> {
  const keys = new Map<string, string[]>(options.map(o => [o.key, []]))
  const candidates = [...options.map(o => o.key).filter(k => k.length === 1 && k.trim() !== ''), ...'123456789']
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const action = keyAction(candidate, options)
    if (action.type === 'choose') keys.get(action.key)?.push(candidate)
  }
  return keys
}

// Whether h holds and m opens the memo: an option whose key is h or m takes the key instead.
export function keyWorks(key: 'h' | 'm', options: Option[]): boolean {
  return keyAction(key, options).type === (key === 'h' ? 'hold' : 'memo')
}

export function ago(ts: number, now = Date.now()): string {
  return agoText(now - ts)
}

export function clock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type Placed = { node: GraphNode; col: number; row: number }
export type Layout = { placed: Placed[]; edges: [string, string][]; cols: number; rows: number }

export function afterOf(node: GraphNode): string[] {
  try {
    const parsed: unknown = JSON.parse(node.after)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

// Columns left to right by the longest chain of nodes before each one; rows
// keep plan order. A cycle or a missing predecessor never loops or drops a node.
export function layoutGraph(nodes: GraphNode[]): Layout {
  const byKey = new Map(nodes.map(n => [n.key, n]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (key: string): number => {
    const known = depth.get(key)
    if (known !== undefined) return known
    const node = byKey.get(key)
    if (!node || visiting.has(key)) return -1
    visiting.add(key)
    const d = Math.max(-1, ...afterOf(node).map(depthOf)) + 1
    visiting.delete(key)
    depth.set(key, d)
    return d
  }
  const rowsUsed: number[] = []
  const placed = nodes.map(node => {
    const col = depthOf(node.key)
    const row = rowsUsed[col] ?? 0
    rowsUsed[col] = row + 1
    return { node, col, row }
  })
  const edges = nodes.flatMap(n => afterOf(n).filter(a => byKey.has(a)).map(a => [a, n.key] as [string, string]))
  return { placed, edges, cols: rowsUsed.length, rows: Math.max(0, ...rowsUsed) }
}

export function stageCounts(nodes: GraphNode[]): { stage: (typeof STAGES)[number]; done: number; total: number }[] {
  return STAGES.map(stage => {
    const inStage = nodes.filter(n => n.stage === stage)
    return { stage, done: inStage.filter(n => n.status === '끝').length, total: inStage.length }
  })
}

// A node that started again (round > 1) went back because of a review after it:
// draw a dashed edge from each review node downstream of it back to it.
export function reviewLoops(nodes: GraphNode[]): { from: string; to: string; round: number }[] {
  const next = new Map<string, string[]>()
  for (const n of nodes) for (const a of afterOf(n)) next.set(a, [...(next.get(a) ?? []), n.key])
  const byKey = new Map(nodes.map(n => [n.key, n]))
  const loops: { from: string; to: string; round: number }[] = []
  for (const node of nodes.filter(n => n.round > 1)) {
    const seen = new Set<string>()
    const stack = [...(next.get(node.key) ?? [])]
    while (stack.length > 0) {
      const key = stack.pop()!
      if (seen.has(key)) continue
      seen.add(key)
      const down = byKey.get(key)
      if (down?.kind === '검토' && down.status !== '대기') loops.push({ from: key, to: node.key, round: node.round })
      stack.push(...(next.get(key) ?? []))
    }
  }
  return loops
}

// Agent descriptions start with "[task title::node key]" so the bridge can tie
// them to a node; on screen the task already shows as a badge, so the prefix goes.
export function stripTaskPrefix(text: string): string {
  return text.replace(/\[[^\][]+?::[^\][]+?\]\s*/g, '')
}

// The task a log line belongs to, matched as the bridge matches it: same session, same title.
export function taskOfEvent<T extends Pick<Task, 'session_id' | 'title'>>(tasks: T[], event: { session_id: string; task_title: string }): T | null {
  if (!event.task_title) return null
  return tasks.find(t => t.session_id === event.session_id && t.title === event.task_title) ?? null
}

// Whether an answer can reach the session now. Claude Code holds its delivery stream
// through the mod, and a CLI in an app terminal through the app; a CLI outside the app
// only polls (check_answers), so the bridge cannot tell. An answer to a gone session
// stays with the bridge and goes in when the session connects again (claude --resume).
export type Reach = 'live' | 'gone' | 'unknown'

export function reachOf(session: Pick<Session, 'id' | 'agent' | 'terminal'> | undefined, live: readonly string[]): Reach {
  if (!session) return 'gone'
  if (live.includes(session.id)) return 'live'
  if (!session.agent || session.agent === 'claude' || session.terminal) return 'gone'
  return 'unknown'
}

// Why a task needs the person now, the strongest reason first: a decision waits, its
// session's turn stalled, its account is at the usage limit, or a running task's session dropped. null: nothing to do.
// One function, so the waiting group and each card agree on the order.
export type Attention = 'question' | 'stalled' | 'limited' | 'offline'

const ATTENTION_ORDER: Attention[] = ['question', 'stalled', 'limited', 'offline']

export function attentionOf(task: { openQuestions: number; stalled: boolean; limited?: boolean; offline: boolean; running: boolean }): Attention | null {
  if (task.openQuestions > 0) return 'question'
  if (task.running && task.stalled) return 'stalled'
  if (task.running && task.limited) return 'limited'
  if (task.running && task.offline) return 'offline'
  return null
}

// The tasks that need the person, strongest reason first, then the newest; and the rest.
export function waitingFirst<T extends { updated_at: number }>(tasks: T[], attention: (task: T) => Attention | null): { waiting: T[]; rest: T[] } {
  const waiting = tasks
    .filter(task => attention(task) !== null)
    .sort((a, b) => ATTENTION_ORDER.indexOf(attention(a)!) - ATTENTION_ORDER.indexOf(attention(b)!) || b.updated_at - a.updated_at)
  return { waiting, rest: tasks.filter(task => attention(task) === null) }
}

// What the task list shows for each task, worked out once per bridge state instead of once per
// task per render: its open questions (same session and title), its node count, and why it needs
// the person. stalled and limited are session ids.
export type TaskFacts = { openQuestions: number; nodeCount: number; attention: Attention | null }

export function taskFacts(
  state: {
    tasks: readonly Task[]
    questions: readonly Pick<Question, 'status' | 'session_id' | 'task_title'>[]
    nodes: readonly Pick<GraphNode, 'task_id'>[]
    sessions: readonly Pick<Session, 'id' | 'agent' | 'terminal'>[]
    live?: readonly string[]
  },
  stalled: ReadonlySet<string>,
  limited: ReadonlySet<string>,
  running: (task: Task) => boolean,
): Map<number, TaskFacts> {
  const key = (session: string, title: string) => `${session}\n${title}`
  const open = new Map<string, number>()
  for (const q of state.questions) {
    if (q.status === 'answered') continue
    const k = key(q.session_id, q.task_title)
    open.set(k, (open.get(k) ?? 0) + 1)
  }
  const nodes = new Map<number, number>()
  for (const n of state.nodes) nodes.set(n.task_id, (nodes.get(n.task_id) ?? 0) + 1)
  const sessions = new Map(state.sessions.map(s => [s.id, s]))
  const live = state.live ?? []
  const facts = new Map<number, TaskFacts>()
  for (const task of state.tasks) {
    const openQuestions = open.get(key(task.session_id, task.title)) ?? 0
    facts.set(task.id, {
      openQuestions,
      nodeCount: nodes.get(task.id) ?? 0,
      attention: attentionOf({
        openQuestions,
        stalled: stalled.has(task.session_id),
        limited: limited.has(task.session_id),
        offline: reachOf(sessions.get(task.session_id), live) === 'gone',
        running: running(task),
      }),
    })
  }
  return facts
}
