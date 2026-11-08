// Time the computer spent asleep is no time anything waited. The bridge's deadlines (a scheduled
// run waiting for a session or its answer, delegated work waiting for its terminal, a permission
// ask nobody polls) are measured with the wall clock, so after a night with the lid closed every
// one of them would be past at the first look, though nothing had a chance to happen.
//
// `check()` is called often (a timer, and each sweep before it judges a deadline): a gap between
// two calls far longer than they come means the computer slept, and the moment it woke is kept.
// A deadline then counts from max(its start, that moment): what waited gets its whole time again.
export const SLEEP_GAP_MS = 60_000
export const SLEEP_LOOK_MS = 10_000

export function sleepClock(now: () => number = Date.now, gapMs = SLEEP_GAP_MS): { check: () => number } {
  let last = now()
  let woke = 0
  return {
    // When the computer last woke (0: not since the bridge started).
    check: () => {
      const at = now()
      if (at - last > gapMs) woke = at
      last = at
      return woke
    },
  }
}
