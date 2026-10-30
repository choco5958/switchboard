// What waited for the session while it was busy goes in as one prompt, so the
// session reads every answer and comment in a single turn. Below: the small pure
// helpers of the bridge subscription.

import { t, type Lang } from './i18n.ts'

export type Delivery = { id: string; text: string }

// Mods before the outbox stored answers as bare numbers: 6 and "q6" are the same answer.
export function normalizeIds(stored: readonly (string | number)[]): string[] {
  return stored.map(id => (typeof id === 'number' ? `q${id}` : id))
}

export function batchText(batch: readonly Delivery[], lang: Lang = 'ko'): string {
  if (batch.length === 1) return batch[0]?.text ?? ''
  const head = t(lang, 'batch.head', { n: batch.length })
  return [head, ...batch.map(d => d.text)].join('\n\n---\n\n')
}

export function toastText(batch: readonly Delivery[], lang: Lang = 'ko'): string {
  const answers = batch.filter(d => d.id.startsWith('q')).map(d => `Q${d.id.slice(1)}`)
  const messages = batch.length - answers.length
  const parts = [
    answers.length > 0 ? t(lang, 'batch.answers', { ids: answers.join(t(lang, 'sep')) }) : '',
    messages > 0 ? t(lang, 'batch.messages', { n: messages }) : '',
  ]
  return t(lang, 'batch.toast', { parts: parts.filter(Boolean).join(t(lang, 'sep')) })
}

// One SSE frame of the bridge's /deliveries stream: its exact `event:` line and its
// data. A delivery whose text mentions "event: command" stays a delivery, because
// the text sits JSON-escaped inside the data line.
export function parseFrame(frame: string): { event: string; data: string } | undefined {
  let event = 'message'
  let data: string | undefined
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data = line.slice(6)
  }
  return data === undefined ? undefined : { event, data }
}

// A list of ids kept in $.store, newest last, never longer than `cap`.
export function remember<T>(list: readonly T[], items: readonly T[], cap: number): T[] {
  return [...list.filter(id => !items.includes(id)), ...items].slice(-cap)
}

// Wait before the next try to reach the bridge: doubling, up to a minute.
export function nextDelay(ms: number, first = 3000, max = 60000): number {
  return Math.min(Math.max(ms * 2, first), max)
}

type PendingQuestion = { id: number; task_title: string; question: string; recommend: string; options?: string }

// One line per question still waiting in the IDE, with the recommended option written
// out as the reference session does: "➡ (a) 지금 고침".
export function pendingLine(q: PendingQuestion, lang: Lang = 'ko'): string {
  let options: { key: string; label: string }[] = []
  try {
    options = JSON.parse(q.options ?? '[]') as { key: string; label: string }[]
  } catch {
    options = []
  }
  const label = options.find(o => o.key === q.recommend)?.label ?? ''
  const recommend = q.recommend ? ` ${t(lang, 'batch.recommend', { key: q.recommend, label })}`.trimEnd() : ''
  return `- Q${q.id} [${q.task_title || t(lang, 'batch.noTask')}] ${q.question}${recommend}`
}

// Store keys of sessions not seen for `maxAge`: a session that crashed never ran its
// session.end, and the store has a 4 MiB limit.
export function staleKeys(keys: readonly string[], seen: Readonly<Record<string, number>>, at: number, maxAge: number): string[] {
  return keys.filter(key => {
    const match = /^(sent|commands|agents|queued|token):(.+)$/.exec(key)
    const last = match ? seen[match[2] ?? ''] : undefined
    return last !== undefined && at - last > maxAge
  })
}

// The prompt a command for the main session becomes, the same words the mod submits:
// a message from the IDE, a report or a sync. Other commands (pause, stop, a
// subagent's transcript) have none.
export function commandPrompt(kind: string, payload: { agentId?: string; text?: string } = {}, lang: Lang = 'ko'): string | undefined {
  if (kind === 'message' && payload.text && !payload.agentId) return t(lang, 'mod.message', { text: payload.text })
  if (kind === 'report') return t(lang, 'mod.reportPrompt')
  if (kind === 'sync') return t(lang, 'mod.syncPrompt')
  return undefined
}

// What POST /deliveries/take handed over (answers, messages, open commands) as the one
// prompt the mod would submit; empty when nothing waited. Agents without the mod get it
// typed into their terminal or through check_answers.
export function takenText(json: { items?: unknown; commands?: unknown }, lang: Lang = 'ko'): string {
  const items = (Array.isArray(json.items) ? json.items : []) as Delivery[]
  const commands = (Array.isArray(json.commands) ? json.commands : []) as { id: number; kind: string; payload?: { agentId?: string; text?: string } }[]
  const prompts = commands.flatMap(c => {
    const prompt = commandPrompt(c.kind, c.payload ?? {}, lang)
    return prompt ? [{ id: `c${c.id}`, text: prompt }] : []
  })
  const all = [...items, ...prompts]
  return all.length > 0 ? batchText(all, lang) : ''
}

type RestateTask = { id: number; session_id: string; title: string; stage: string; status: string; now: string }
type RestateNode = { task_id: number; key: string; title: string; status: string }
type RestateQuestion = { id: number; session_id: string; question: string; status: string }
type RestateWait = { id: number; note: string }

// After a compaction the summary may have lost what Switchboard tracks for this session: its
// tasks, their nodes, the questions still open and the waits. The next prompt carries them.
export function restateText(
  state: { tasks?: RestateTask[]; nodes?: RestateNode[]; questions?: RestateQuestion[] },
  waits: readonly RestateWait[],
  sessionId: string,
  lang: Lang = 'ko',
): string | undefined {
  const tasks = (state.tasks ?? []).filter(task => task.session_id === sessionId && task.status !== '보관')
  const questions = (state.questions ?? []).filter(q => q.session_id === sessionId && q.status !== 'answered')
  if (tasks.length === 0 && questions.length === 0 && waits.length === 0) return undefined
  const lines = [t(lang, 'mod.restate')]
  for (const task of tasks) {
    lines.push(t(lang, 'mod.restateTask', { title: task.title, stage: task.stage, status: task.status, now: task.now || '-' }))
    for (const node of (state.nodes ?? []).filter(n => n.task_id === task.id)) lines.push(`  - ${node.key} [${node.status}] ${node.title}`)
  }
  for (const q of questions) lines.push(t(lang, 'mod.restateQuestion', { id: q.id, question: q.question }))
  for (const w of waits) lines.push(t(lang, 'mod.restateWait', { id: w.id, note: w.note.split('\n')[0] ?? '' }))
  return lines.join('\n')
}

// Longest summary a permission ask may have and still be answered away from the terminal.
export const APPROVAL_MAX = 3000
// Characters that make text read differently from what it is (direction overrides, zero width,
// line separators and the other format characters).
const HIDING = /[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\p{Cf}]/u

// What a permission ask would run, for the person deciding away from the terminal: the
// command first, with the switches that change what it does, then the model's own
// description, short; the file and the change; the address; or the arguments of another
// tool. `complete` is false when the person could not see all of it there (cut, hidden
// characters, a change the summary cannot show) or should not answer it there (a command
// outside the sandbox), and then only the terminal asks.
export function approvalSummary(tool: string, input: unknown): { summary: string; complete: boolean } {
  const v = (input ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const whole = (value: string, shows = true) => ({
    summary: value.length > APPROVAL_MAX ? `${value.slice(0, APPROVAL_MAX - 1)}…` : value,
    complete: shows && value.length <= APPROVAL_MAX && !HIDING.test(value),
  })
  // A switch set to true, as its own line the description cannot push out of view.
  const flags = (...names: string[]) => names.filter(name => v[name] === true).map(name => `\n[${name}: true]`).join('')
  if (tool === 'Bash') {
    const about = text(v.description).replace(/\s+/g, ' ').trim().slice(0, 200)
    const head = `${text(v.command)}${flags('dangerouslyDisableSandbox', 'run_in_background')}`
    return whole(about ? `${head}\n# ${about}` : head, v.dangerouslyDisableSandbox !== true)
  }
  if (tool === 'Write') return whole(`${text(v.file_path)}\n${text(v.content)}`)
  if (tool === 'Edit') return whole(`${text(v.file_path)}${flags('replace_all')}\n- ${text(v.old_string)}\n+ ${text(v.new_string)}`)
  if (tool === 'MultiEdit' || tool === 'NotebookEdit') return whole(text(v.file_path) || text(v.notebook_path), false)
  if (tool === 'Read') return whole(text(v.file_path) || JSON.stringify(v))
  if (tool === 'WebFetch') return whole(text(v.url))
  return whole(JSON.stringify(v, null, 1))
}
