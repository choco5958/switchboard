// Messages between sessions (send_to_session): how one reads in the session that gets it,
// and how a forwarded decision question takes its answer back. Pure, so the tests read
// the exact prompts.
//
// A message is collaborator input, never an instruction from the person: the header
// says so, and says how to answer. A request expects one reply (Status, Result,
// Evidence); a reply and plain information expect none, so two sessions never answer
// each other's answers back and forth.

import { tIn, type Lang } from '../src/shared/i18n/index.ts'

export const PEER_TEXT_MAX = 20_000
export const PEER_RECIPIENTS_MAX = 8
// Answers to a request sent to several sessions wait for each other this long at most.
export const HELD_REPLY_MS = 15 * 60_000
// Requests one person's request may lead to between sessions, all hand-offs counted: a
// session that hands work on and on stops here instead of circling.
export const DELEGATION_MAX = 8
// A session gone this long gets its sender told not to wait (a bridge restart is shorter).
export const OFFLINE_NOTE_MS = 2 * 60_000
// A request a session got this long ago no longer makes what it sends part of that run.
export const CHAIN_WINDOW_MS = 6 * 3600_000

export type NoReply = 'offline' | 'interrupted' | 'late'

export type PeerRow = {
  id: number
  from_session: string
  reply_to: number | null
  expects_reply: number
  text: string
}

export type ForwardedQuestion = {
  id: number
  question: string
  body: string
  options: string // JSON of { key, label }[]
  recommend: string
  reason: string
}

// `autoReply`: the recipient is a Claude Code session, whose mod sends its last answer when
// the turn ends without a reply; other CLIs must reply themselves.
export function peerText(row: PeerRow, sender: string, lang: Lang, autoReply: boolean): string {
  const lines = [tIn(lang, 'peer.head', { sender }), tIn(lang, 'peer.messageId', { id: row.id })]
  if (row.reply_to) lines.push(tIn(lang, 'peer.replyTo', { id: row.reply_to }))
  lines.push(tIn(lang, 'peer.collaborator'))
  if (row.reply_to) lines.push(tIn(lang, 'peer.replyRules'))
  else if (!row.expects_reply) lines.push(tIn(lang, 'peer.infoRules'))
  else {
    lines.push(tIn(lang, 'peer.requestRules', { id: row.id }))
    if (autoReply) lines.push(tIn(lang, 'peer.autoReply'))
  }
  lines.push(tIn(lang, 'peer.body'), row.text)
  return lines.join('\n')
}

export function forwardText(rowId: number, q: ForwardedQuestion, asker: string, lang: Lang, autoReply: boolean): string {
  const options = parseOptions(q.options)
  const lines = [
    tIn(lang, 'peer.forwardHead', { id: q.id, asker }),
    tIn(lang, 'peer.messageId', { id: rowId }),
    tIn(lang, 'peer.collaborator'),
    '',
    tIn(lang, 'prompt.answer.question', { question: q.question }),
  ]
  if (q.body) lines.push(q.body)
  for (const o of options) lines.push(`(${o.key}) ${o.label}${o.key === q.recommend ? ` ${tIn(lang, 'peer.recommended')}` : ''}`)
  if (q.reason) lines.push(tIn(lang, 'peer.reason', { reason: q.reason }))
  lines.push('', tIn(lang, 'peer.forwardRules', { id: rowId }))
  if (autoReply) lines.push(tIn(lang, 'peer.forwardAuto'))
  return lines.join('\n')
}

function parseOptions(json: string): { key: string; label: string }[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? (list as { key: string; label: string }[]) : []
  } catch {
    return []
  }
}

// A session's answer to a forwarded question: the option key it named first ("a", "(a)",
// "a." or "a) 이유"), and its words as the memo. No key it could name: the words alone.
export function forwardedAnswer(text: string, optionsJson: string): { choice: string | null; memo: string } {
  const keys = parseOptions(optionsJson).map(o => o.key)
  const first = text.trim().split('\n')[0] ?? ''
  const match = first.match(/^\s*[([]?\s*([A-Za-z0-9])\s*[)\].:,]?(?:\s|$)/)
  const choice = match ? (keys.find(k => k.toLowerCase() === match[1]!.toLowerCase()) ?? null) : null
  return { choice, memo: text.trim().slice(0, 4000) }
}

export function clipText(text: string): string {
  return text.length > PEER_TEXT_MAX ? `${text.slice(0, PEER_TEXT_MAX - 1)}…` : text
}

// A request typed in the shell (switchboard send): the person waits there for the result.
export function shellText(row: { id: number; text: string }, lang: Lang, autoReply: boolean): string {
  return [
    tIn(lang, 'peer.shellHead', { id: row.id }),
    tIn(lang, autoReply ? 'peer.shellAuto' : 'peer.shellReply', { id: row.id }),
    tIn(lang, 'peer.body'),
    row.text,
  ].join('\n')
}

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A scheduled prompt (bridge/schedule.ts) as the session reads it: nobody may be at the
// screen, so it says how to end quietly and how to report a failure.
export function routineText(name: string, prompt: string, scheduledFor: number, lang: Lang): string {
  return [tIn(lang, 'peer.routineHead', { name, time: hhmm(scheduledFor) }), tIn(lang, 'peer.routineRules'), tIn(lang, 'peer.body'), prompt].join('\n')
}

// await_event: the event a session waited for came (switchboard fire).
export function waitText(wait: { id: number; note: string; payload: string }, lang: Lang): string {
  const lines = [tIn(lang, 'peer.waitHead', { id: wait.id }), tIn(lang, 'peer.waitNote', { note: wait.note })]
  if (wait.payload) lines.push(tIn(lang, 'peer.waitPayload'), wait.payload)
  lines.push(tIn(lang, 'peer.waitGo'))
  return lines.join('\n')
}

// The sender of a request that will not be answered, or not in time: it should stop waiting.
export function noReplyText(id: number, recipient: string, reason: NoReply, lang: Lang): string {
  const key = ({ offline: 'peer.noReplyOffline', interrupted: 'peer.noReplyInterrupted', late: 'peer.noReplyLate' } as const)[reason]
  return tIn(lang, key, { id, recipient, minutes: Math.round(HELD_REPLY_MS / 60_000) })
}

// The session working on a request its sender cancelled (cancel_request).
export function cancelledText(id: number, sender: string, reason: string, lang: Lang): string {
  const lines = [tIn(lang, 'peer.cancelled', { id, sender })]
  if (reason.trim()) lines.push(tIn(lang, 'peer.cancelReason', { reason: reason.trim().slice(0, 500) }))
  lines.push(tIn(lang, 'peer.cancelRules', { id }))
  return lines.join('\n')
}
