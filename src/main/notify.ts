import type { Question } from '../shared/types'

export type PendingScan = {
  // Ids to remember for the next comparison.
  ids: Set<number>
  // Pending questions not seen before; empty on the baseline pass.
  fresh: Question[]
  count: number
}

// The first state after launch is only a baseline: pending questions that were
// already waiting must not fire a burst of notifications at startup.
export function scanPending(questions: Question[], previous: Set<number> | null): PendingScan {
  const pending = questions.filter(q => q.status === 'pending')
  const ids = new Set(pending.map(q => q.id))
  const fresh = previous === null ? [] : pending.filter(q => !previous.has(q.id))
  return { ids, fresh, count: pending.length }
}

export function firstLine(text: string, max = 80): string {
  const line = (text.split('\n').find(l => l.trim() !== '') ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function badgeText(count: number): string {
  return count > 0 ? String(count) : ''
}

// Several at once collapse into one notification so a batch does not flood the screen.
export type NotifyPlan = { title: string; body: string; questionId: number | null } | { many: number }

export function planNotification(fresh: Question[]): NotifyPlan | null {
  const q = fresh[0]
  if (!q) return null
  if (fresh.length > 1) return { many: fresh.length }
  return { title: q.project, body: firstLine(q.question), questionId: q.id }
}

// Sessions that stalled since the last pass (src/shared/stall.ts). Once per stall: a session
// leaves the set when it moves again, so a later stall notifies again.
export function scanStalled(stalled: readonly string[], previous: Set<string>): { ids: Set<string>; fresh: string[] } {
  return { ids: new Set(stalled), fresh: stalled.filter(id => !previous.has(id)) }
}
