import { useSyncExternalStore } from 'react'
import type { DevStatus, DevTarget, Reply } from '../../shared/types'
import { t } from '../../shared/i18n'

// Shared by the debugging sidebar (DebugPanel) and the browser (DebugPage),
// which App renders in different places: the chosen session, the selected dev
// server, a request to open a url in the browser, and one to add a target.
export type DebugState = {
  session: string // '' means the most recent live session
  targetId: string
  open: { url: string; seq: number; fresh: boolean } | null // fresh: the server was just (re)started
  addTarget: { url: string; seq: number } | null // the browser's error page asks the sidebar for a new target
  live: string[] | null // sessions whose mod is connected; null until the bridge answered
}

// The debugging page's own bridge routes (bridge/debug.ts), exposed by the preload.
declare global {
  interface Window {
    ideDebug: { call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply> }
  }
}

const KEY = 'claude-ide:debug'

function load(): DebugState {
  const empty: DebugState = { session: '', targetId: '', open: null, addTarget: null, live: null }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DebugState>
    return { ...empty, session: saved.session ?? '', targetId: saved.targetId ?? '' }
  } catch {
    return empty
  }
}

let state: DebugState = load()
const listeners = new Set<() => void>()

function set(next: Partial<DebugState>): void {
  state = { ...state, ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify({ session: state.session, targetId: state.targetId }))
  } catch {
    // per-viewer convenience only
  }
  for (const listener of listeners) listener()
}

export const debugStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setSession: (session: string) => set({ session }),
  setTarget: (targetId: string) => set({ targetId }),
  setLive: (live: string[]) => {
    if (state.live && state.live.length === live.length && state.live.every((id, i) => id === live[i])) return
    set({ live })
  },
  openUrl: (url: string, fresh = false) => set({ open: { url, seq: (state.open?.seq ?? 0) + 1, fresh } }),
  requestTarget: (url: string) => set({ addTarget: { url, seq: (state.addTarget?.seq ?? 0) + 1 } }),
}

export function useDebugStore(): DebugState {
  return useSyncExternalStore(debugStore.subscribe, debugStore.get)
}

type SessionLike = { id: string; project: string; cwd: string }

// Sessions comments and direct input can go to: in the chosen project (null is
// every project) and alive, newest first as the bridge lists them. Before the
// bridge said which are alive, every session in the project counts.
export function sendable<T extends SessionLike>(sessions: T[], scope: string | null | undefined, live: string[] | null): T[] {
  return sessions.filter(s => (scope ? s.project === scope : true) && (live ? live.includes(s.id) : true))
}

// The session to send to: the chosen one while it is still sendable, else the newest sendable one.
export function sessionFor<T extends SessionLike>(chosen: string, sessions: T[], scope?: string | null, live: string[] | null = null): T | undefined {
  const list = sendable(sessions, scope, live)
  return list.find(s => s.id === chosen) ?? list[0]
}

function sameFolder(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/\/+$/, '')
  return !!a && !!b && trim(a) === trim(b)
}

export function whereTo(session: SessionLike, target?: DevTarget): string {
  if (target && sameFolder(session.cwd, target.repo)) return t('debug.whereSameRepo', { id: session.id.slice(0, 8) })
  return t('debug.whereProject', { project: session.project, id: session.id.slice(0, 8) })
}

// Why a page did not load, in words; the Chromium code stays visible beside it.
export function failureReason(code: string): string {
  if (code === 'ERR_CONNECTION_REFUSED') return t('debug.fail.refused')
  if (code === 'ERR_NAME_NOT_RESOLVED') return t('debug.fail.dns')
  if (code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT') return t('debug.fail.timeout')
  if (code === 'ERR_ADDRESS_UNREACHABLE' || code === 'ERR_INTERNET_DISCONNECTED') return t('debug.fail.unreachable')
  if (code === 'ERR_CONNECTION_RESET' || code === 'ERR_EMPTY_RESPONSE') return t('debug.fail.reset')
  if (code.startsWith('ERR_CERT_')) return t('debug.fail.cert')
  if (code === 'ERR_INVALID_URL') return t('debug.fail.invalidUrl')
  return t('debug.fail.other')
}

// After a start: wait until the server answers, reporting each status on the way.
export async function waitUntilAnswering(target: DevTarget, onStatus: (status: DevStatus) => void = () => undefined, waitMs = 30_000): Promise<boolean> {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    const status = await window.ide.devStatus(target)
    onStatus(status)
    if (status.responding) return true
    if (!status.running) return false
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  return false
}

// What the bridge sends when a session calls open_in_ide (bridge/debug.ts).
export type OpenEvent = { id: string; at: number; url: string; sessionId: string; target: DevTarget | null; restart: boolean }

export type OpenAction = 'restart' | 'start' | 'open'

// What the IDE does for one request: a changed target this app runs restarts,
// a target nobody answers for starts, anything else only opens the page (a
// server started outside the app keeps its port, so a second one would fail).
export function openAction(event: OpenEvent, status: DevStatus | null): OpenAction {
  if (!event.target) return 'open'
  if (status?.running) return event.restart ? 'restart' : status.responding ? 'open' : 'restart'
  return status?.responding || status?.listening ? 'open' : 'start'
}
