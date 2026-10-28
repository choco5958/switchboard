// The dock owns the terminals, so the top bar asks it to open one on a slot through this window event.
export const OPEN_CLAUDE_SLOT = 'switchboard:open-claude-slot'

// Whole days left before the refresh token stops working; negative once it has. Rounded down so the
// warning never promises more time than there is.
export function refreshDaysLeft(expiresAt: number, now = Date.now()): number {
  return Math.floor((expiresAt - now) / 86400_000)
}
