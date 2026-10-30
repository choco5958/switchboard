// Answers from the decision card wait a few seconds in this window before they go to the bridge,
// so the toast's Undo can take one back: until the wait is over nothing has left the app, and the
// session has seen nothing. After that the answer is the session's, and there is no undo.
// The window closing (or reloading) sends whatever still waits at once rather than dropping it.
// Each waiting answer is also written to localStorage until the bridge has it, so one the app
// could not send (a forced quit, a crash) goes at the next start (resendLeft). A second send of
// an answer the bridge already has is refused there and changes nothing.

export const SEND_DELAY_MS = 5000

export type Draft = { choice: string; memo: string }
type Waiting = Draft & { timer: ReturnType<typeof setTimeout>; send: () => Promise<void> }

// Sends, then drops the stored copy whether the bridge took it or refused it (the toast says which).
const go = (id: number, entry: Pick<Waiting, 'send'>) => void entry.send().then(() => forget(id))

const waiting = new Map<number, Waiting>()
// What an Undo took back, so the card that opens again starts from it.
const drafts = new Map<number, Draft>()
const listeners = new Set<() => void>()

const STORE = 'switchboard.outbox'
type Stored = Record<string, Draft>
function stored(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Stored) : {}
  } catch {
    return {}
  }
}
function store(change: (all: Stored) => void): void {
  try {
    const all = stored()
    change(all)
    if (Object.keys(all).length === 0) localStorage.removeItem(STORE)
    else localStorage.setItem(STORE, JSON.stringify(all))
  } catch {
    // No storage (a private window, a test): the answer still goes when its wait is over.
  }
}
const keep = (id: number, draft: Draft) => store(all => void (all[id] = { choice: draft.choice, memo: draft.memo }))
const forget = (id: number) => store(all => void delete all[id])

// Sends the answers an earlier run of the app kept but never got to the bridge, once, at start.
// post resolves true when the bridge took the answer or already had one; false leaves it for the next start.
export async function resendLeft(post: (id: number, draft: Draft) => Promise<boolean>): Promise<void> {
  for (const [key, draft] of Object.entries(stored())) {
    const id = Number(key)
    if (!Number.isInteger(id) || waiting.has(id) || typeof draft?.choice !== 'string' || typeof draft.memo !== 'string') {
      forget(id)
      continue
    }
    if (await post(id, draft)) forget(id)
  }
}

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
    go(id, { send })
  }, delay)
  waiting.set(id, { ...draft, timer, send })
  keep(id, draft)
  changed()
}

// Undo: the answer stays in the app, never sent. null once it has gone (or never waited).
export function takeBack(id: number): Draft | null {
  const entry = waiting.get(id)
  if (!entry) return null
  clearTimeout(entry.timer)
  waiting.delete(id)
  forget(id)
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
  const all = [...waiting.entries()]
  waiting.clear()
  for (const [id, entry] of all) {
    clearTimeout(entry.timer)
    go(id, entry)
  }
  if (all.length > 0) changed()
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushAll)
