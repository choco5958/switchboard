// Answers from the decision card wait a few seconds in this window before they go to the bridge,
// so the toast's Undo can take one back: until the wait is over nothing has left the app, and the
// session has seen nothing. After that the answer is the session's, and there is no undo.
// The window closing (or reloading) sends whatever still waits at once rather than dropping it.

export const SEND_DELAY_MS = 5000

export type Draft = { choice: string; memo: string }
type Waiting = Draft & { timer: ReturnType<typeof setTimeout>; send: () => Promise<void> }

const waiting = new Map<number, Waiting>()
// What an Undo took back, so the card that opens again starts from it.
const drafts = new Map<number, Draft>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isWaiting(id: number): boolean {
  return waiting.has(id)
}

// The ids still waiting, for picking the next question to open.
export function waitingIds(): Set<number> {
  return new Set(waiting.keys())
}

// send runs once the delay is over, unless takeBack came first. A second answer to the same
// question replaces the first.
export function queueAnswer(id: number, draft: Draft, send: () => Promise<void>, delay = SEND_DELAY_MS): void {
  const before = waiting.get(id)
  if (before) clearTimeout(before.timer)
  drafts.delete(id)
  const timer = setTimeout(() => {
    waiting.delete(id)
    changed()
    void send()
  }, delay)
  waiting.set(id, { ...draft, timer, send })
  changed()
}

// Undo: the answer stays in the app, never sent. null once it has gone (or never waited).
export function takeBack(id: number): Draft | null {
  const entry = waiting.get(id)
  if (!entry) return null
  clearTimeout(entry.timer)
  waiting.delete(id)
  const draft = { choice: entry.choice, memo: entry.memo }
  drafts.set(id, draft)
  changed()
  return draft
}

export function draftOf(id: number): Draft | undefined {
  return drafts.get(id)
}

// Everything still waiting goes now.
export function flushAll(): void {
  const all = [...waiting.values()]
  waiting.clear()
  for (const entry of all) {
    clearTimeout(entry.timer)
    void entry.send()
  }
  if (all.length > 0) changed()
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushAll)
