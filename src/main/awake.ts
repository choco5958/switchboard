// While an agent is working the Mac does not sleep, so a long run left alone finishes (the
// screen may still turn off). Only sessions still connected count, and a turn that has said
// nothing for AWAKE_MAX_MS is taken as stuck rather than working. The idea is Orca's
// agent-awake-service.ts (MIT, github.com/stablyai/orca).

import type { Activity } from '../shared/stall'

export const AWAKE_MAX_MS = 2 * 3600_000

export function anyoneWorking(activity: Record<string, Activity>, live: readonly string[], now: number): boolean {
  return Object.entries(activity).some(([id, a]) => a.state === 'working' && live.includes(id) && now - a.at < AWAKE_MAX_MS)
}
