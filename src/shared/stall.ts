// A session whose turn runs but shows no sign of work: no hook event for STALL_MS and no
// tool call open (a long build or a subagent keeps a call open, so it never counts). It is
// often Claude Code waiting at a permission prompt in its terminal, or a hung request;
// either way a person should look. A session whose stream closed is offline, not stalled.

export const STALL_MS = 5 * 60_000

export type Activity = {
  state: 'working' | 'idle'
  openTools: number
  at: number // the last hook event the bridge heard of, ms
}

export function stalledSessions(
  activity: Record<string, Activity>,
  live: readonly string[],
  now: number,
  ms = STALL_MS,
): string[] {
  return Object.entries(activity)
    .filter(([id, a]) => a.state === 'working' && a.openTools === 0 && now - a.at >= ms && live.includes(id))
    .map(([id]) => id)
}
