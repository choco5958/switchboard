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
    const match = /^(sent|commands|agents|queued):(.+)$/.exec(key)
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
