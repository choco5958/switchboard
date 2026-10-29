// A session that hit its plan's usage limit: Claude Code's last usage report has a window at
// 100% that resets later. Answers and messages for it wait in the bridge until the reset and
// 30 seconds more (typed in before, they would only meet the same refusal). A session that
// ccr started is left alone: ccr moves it to the next account and carries on.
// With no reset time in the report, the hold lasts UNKNOWN_RESET_MS from the report.

import type { SessionUsage } from './types'

export const RESET_GRACE_MS = 30_000
export const UNKNOWN_RESET_MS = 15 * 60_000

function resetAt(value: unknown): number | null {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value) {
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
  }
  return null
}

// When the hold ends, or null when there is none. `reportedAt` is when the usage came in.
export function limitedUntil(usageJson: string | undefined, reportedAt: number, now: number): number | null {
  let usage: SessionUsage
  try {
    usage = JSON.parse(usageJson || '{}') as SessionUsage
  } catch {
    return null
  }
  if (usage.ccrSlot) return null
  let until: number | null = null
  for (const limit of usage.rateLimits ?? []) {
    if (!(limit.percentUsed >= 100)) continue
    const at = resetAt(limit.resetsAt)
    const end = (at ?? reportedAt + UNKNOWN_RESET_MS - RESET_GRACE_MS) + RESET_GRACE_MS
    if (end > now && (until === null || end > until)) until = end
  }
  return until
}
