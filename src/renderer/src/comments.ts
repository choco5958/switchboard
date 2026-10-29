import type { Pick } from './picker'
import { t } from '../../shared/i18n'

export const COMMENT_STATUSES = ['열림', '보냄', '해결'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]
export type CommentFilter = CommentStatus | '전체'

// A screen comment as the bridge keeps it (table comments), so it outlives the app.
export type Comment = {
  id: number
  url: string // the page, without its #fragment
  place: string // 본문 › 현황판 쪽 › "미시작" 꼬리표
  css: string
  element: string // button "저장"
  text: string
  shot: string | null
  logs?: string // console and failed requests of the page when the comment was made (src/shared/pageLog.ts)
  session_id: string
  status: CommentStatus
  created_at: number
  updated_at: number
  sent_at: number | null
  resolved_at: number | null
}

export function describe(pick: Pick): string {
  const text = pick.text ? ` "${pick.text.replace(/\s+/g, ' ').slice(0, 60)}"` : ''
  return `${pick.tag}${text}`
}

export function pageKey(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

// What POST /comments takes for a pick and its memo.
export function commentBody(pick: Pick, memo: string, shot: string | null, sessionId: string, logs = '') {
  return {
    logs,
    url: pageKey(pick.url),
    place: pick.crumbs?.length ? pick.crumbs.join(' › ') : '',
    css: pick.selector,
    element: describe(pick),
    text: memo,
    shot,
    sessionId,
  }
}

export function countByStatus(comments: Comment[]): Record<CommentFilter, number> {
  const counts: Record<CommentFilter, number> = { 열림: 0, 보냄: 0, 해결: 0, 전체: comments.length }
  for (const c of comments) counts[c.status]++
  return counts
}

export function filterComments(comments: Comment[], filter: CommentFilter): Comment[] {
  return filter === '전체' ? comments : comments.filter(c => c.status === filter)
}

// One prompt for the whole batch: the session reads every comment in one turn.
export function commentPrompt(comments: Comment[]): string {
  const urls = [...new Set(comments.map(c => c.url))]
  const lines = [t('prompt.comments.head', { n: comments.length })]
  if (urls.length === 1) lines.push(t('prompt.comments.url', { url: urls[0]! }))
  comments.forEach((c, i) => {
    lines.push('')
    lines.push(`${i + 1}. ${t('prompt.comments.element', { element: c.element || c.css })}`)
    if (c.place) lines.push(`   ${t('prompt.comments.place', { place: c.place })}`)
    lines.push(`   CSS: ${c.css}`)
    if (urls.length > 1) lines.push(`   ${t('prompt.comments.url', { url: c.url })}`)
    if (c.shot) lines.push(`   ${t('prompt.comments.shot', { path: c.shot })}`)
    if (c.logs) {
      lines.push(`   ${t('prompt.comments.logs')}`)
      for (const line of c.logs.split('\n')) lines.push(`     ${line}`)
    }
    lines.push(`   ${t('prompt.comments.request', { text: c.text })}`)
  })
  lines.push('')
  lines.push(t('prompt.comments.ask'))
  return lines.join('\n')
}

// "15:04" today, "10-26 15:04" on another day.
export function shortTime(at: number, now = Date.now()): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}
