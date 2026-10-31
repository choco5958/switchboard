// How the mod's tool.check hook waits for the person's answer to a permission ask sent to the
// app and Telegram (register.ts). A hook has 10 s of its own time, and a `$.clock.sleep` is
// spent from it, while a `$` call such as a fetch is not: so the wait is a chain of long polls
// (GET /approvals/:id?wait=ms on the bridge), each answering as soon as the person answers.
// Pure, so a unit test plays the bridge and the clock (mod/tests/approval.unit.ts).

export type PollReply = { ok: boolean; status: number; json: Record<string, unknown> }

export type ApprovalWait = {
  // When the hook stops waiting and the terminal asks instead.
  until: number
  now: () => Promise<number>
  // One long poll; rejects or answers status 0 when the bridge is out of reach.
  poll: (waitMs: number) => Promise<PollReply>
  // The call was abandoned (the person pressed Esc, a hook above settled).
  aborted: () => boolean
  // Starts the bridge again if it is down; true when one answers.
  reconnect: () => Promise<boolean>
  // Only for a bridge from before long polls, which answers at once.
  sleep: (ms: number) => Promise<void>
  // Tells the bridge nobody waits for this ask any more.
  abandon: () => Promise<unknown>
}

// Below the bridge's own cap (APPROVAL_POLL_MAX_MS, 25 s), and shortened if a poll this long fails.
export const APPROVAL_POLL_MS = 20_000
const MIN_POLL_MS = 2_000
const MAX_MISSES = 5

export type ApprovalAnswer = { answer: 'allow' | 'deny' | 'ask'; note: string }

// 'allow' or 'deny' from the person, a deny with what they wrote for the session (`note`, or '');
// 'ask' hands the call back to the terminal's dialog.
export async function waitApproval(w: ApprovalWait): Promise<ApprovalAnswer> {
  let pollMs = APPROVAL_POLL_MS
  let misses = 0
  for (;;) {
    if (w.aborted()) break
    const left = w.until - (await w.now())
    if (left <= 0) break
    const reply = await w.poll(Math.min(left, pollMs)).catch((): PollReply => ({ ok: false, status: 0, json: {} }))
    if (reply.status === 0) {
      // Out of reach: the bridge restarting, or a poll held longer than the host lets a fetch run.
      misses += 1
      pollMs = Math.max(MIN_POLL_MS, Math.floor(pollMs / 2))
      if (misses >= MAX_MISSES || !(await w.reconnect().catch(() => false))) break
      continue
    }
    misses = 0
    // 404: the ask is gone (a new database).
    if (!reply.ok) break
    const status = reply.json.status
    if (status === 'allow' || status === 'deny') return { answer: status, note: status === 'deny' && typeof reply.json.note === 'string' ? reply.json.note.trim() : '' }
    // 'terminal', 'expired': settled elsewhere, nothing to tell the bridge.
    if (status !== 'pending') return { answer: 'ask', note: '' }
    if (typeof reply.json.waitMs !== 'number') await w.sleep(1000).catch(() => undefined)
  }
  await w.abandon().catch(() => undefined)
  return { answer: 'ask', note: '' }
}
