// When a scheduled prompt (bridge/routines.ts) runs next, in the computer's local time.
// Pure: the tests move the clock. Four kinds, as the person sets them in the app:
//   daily     every day at time
//   weekdays  Monday to Friday at time
//   interval  every `every` minutes, counted from `anchor`
//   once      at `at` (a local "YYYY-MM-DDTHH:MM"), then never again

export type Schedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'interval'; every: number; anchor: number }
  | { kind: 'once'; at: string }

export const MIN_INTERVAL_MINUTES = 5

// A routine whose runs keep failing switches itself off after this many in a row, so a broken
// prompt does not spend the model on every run until someone looks.
export const ROUTINE_FAIL_LIMIT = 5

function clock(time: string): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) return null
  const [h, m] = [Number(match[1]), Number(match[2])]
  return h < 24 && m < 60 ? [h, m] : null
}

// A schedule from what the app or a tool sent, or the reason it is not one.
export function parseSchedule(value: unknown, now: number): Schedule | { error: string } {
  const v = (value ?? {}) as Record<string, unknown>
  if (v.kind === 'daily' || v.kind === 'weekdays') {
    const time = String(v.time ?? '')
    return clock(time) ? { kind: v.kind, time } : { error: `bad time: ${time}` }
  }
  if (v.kind === 'interval') {
    const every = Math.floor(Number(v.every))
    if (!(every >= MIN_INTERVAL_MINUTES)) return { error: `interval below ${MIN_INTERVAL_MINUTES} minutes` }
    const anchor = Number(v.anchor)
    return { kind: 'interval', every, anchor: Number.isFinite(anchor) && anchor > 0 ? anchor : now }
  }
  if (v.kind === 'once') {
    const at = String(v.at ?? '')
    return Number.isNaN(localTime(at)) ? { error: `bad date: ${at}` } : { kind: 'once', at }
  }
  return { error: `unknown kind: ${String(v.kind)}` }
}

function localTime(at: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at)
  if (!match) return Number.NaN
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number]
  return new Date(y, mo - 1, d, h, mi).getTime()
}

// The first run strictly after `after`; null when there is none (a once that has passed).
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.kind === 'once') {
    const at = localTime(schedule.at)
    return at > after ? at : null
  }
  if (schedule.kind === 'interval') {
    const step = schedule.every * 60_000
    if (after < schedule.anchor) return schedule.anchor
    return schedule.anchor + (Math.floor((after - schedule.anchor) / step) + 1) * step
  }
  const [h, m] = clock(schedule.time) ?? [9, 0]
  const day = new Date(after)
  for (let i = 0; i < 8; i++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i, h, m).getTime()
    const weekday = new Date(at).getDay()
    if (at > after && (schedule.kind === 'daily' || (weekday !== 0 && weekday !== 6))) return at
  }
  return null
}
