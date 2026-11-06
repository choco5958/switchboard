import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDetect, TermInfo } from '../../shared/types'
import { CLAUDE_MIN, olderThan, PRESETS, type CustomAgent } from '../../shared/agents'
import { TerminalView } from './TerminalView'
import { RESUME_SESSION } from './parts'
import { OPEN_CLAUDE_SLOT } from '../../shared/ccr'
import { t } from '../../shared/i18n'

// The app's terminals. Each one is a session row in the sidebar (sessions.ts); the session view
// shows the chosen one in the main area. Every terminal stays mounted, so switching rows only
// hides them and their scrollback and running program survive.

// How long a resumed session's terminal takes the next press of its button (resume below).
const RESUME_WAIT_MS = 30_000

export const AGENTS_FOUND = 'switchboard:agents-found'
// Another screen asks for one terminal (detail: its id), such as the task view's "go to terminal";
// and the terminals tell whoever listens which ones there are (detail: TermInfo[]) as they change.
export const SHOW_TERMINAL = 'switchboard:show-terminal'
export const TERMS_CHANGED = 'switchboard:terms-changed'

// One row of the agent picker: an agent CLI the dock can open, and how it joins Switchboard.
// via: 'mod' (Claude Code), 'mcp' (the connection server attached to that run) or 'plain' (a
// terminal only). installed: false for a preset CLI not found on this computer, shown with how
// to install it. warn: why it may not work (Claude Code missing or too old); blocked: it cannot.
export type AgentChoice = {
  kind: string
  label: string
  via: 'mod' | 'mcp' | 'plain'
  installed: boolean
  title: string
  menuTitle: string
  warn?: string
  blocked?: boolean
}

// Every agent the dock offers, the preferred one first (the last one opened), then Claude Code,
// the installed CLIs and the person's own, and last the known CLIs not installed here.
// `showOthers` false (settings) leaves Claude Code alone.
export function agentChoices(found: AgentDetect | null, customs: readonly CustomAgent[], showOthers = true, preferred?: string): AgentChoice[] {
  const missing = found !== null && !found.found.claude
  const old = !missing && found?.claudeVersion && olderThan(found.claudeVersion, CLAUDE_MIN) ? found.claudeVersion : null
  const warn = missing ? t('dock.claudeMissing') : old ? t('dock.claudeOld', { version: old, need: CLAUDE_MIN }) : undefined
  const claude: AgentChoice = { kind: 'claude', label: 'Claude Code', via: 'mod', installed: !missing, title: warn ?? t('dock.newClaudeTitle'), menuTitle: t('dock.menuClaude'), warn, blocked: missing }
  if (!showOthers) return [claude]
  const preset = (p: (typeof PRESETS)[number], installed: boolean): AgentChoice => ({
    kind: p.id,
    label: p.label,
    via: p.mcp ? 'mcp' : 'plain',
    installed,
    title: installed ? t(p.mcp ? 'dock.agentTitle' : 'dock.agentPlainTitle', { command: p.bin }) : t('agents.notInstalled', { label: p.label, install: p.install }),
    menuTitle: t('dock.menuAgent', { label: p.label }),
    blocked: !installed,
  })
  const usable: AgentChoice[] = [
    claude,
    ...PRESETS.filter(p => found?.found[p.bin]).map(p => preset(p, true)),
    ...customs.map((c): AgentChoice => ({
      kind: c.id,
      label: c.name,
      via: c.mcp === 'none' ? 'plain' : 'mcp',
      installed: true,
      title: t(c.mcp === 'none' ? 'dock.agentPlainTitle' : 'dock.agentTitle', { command: c.command }),
      menuTitle: t('dock.menuAgent', { label: c.name }),
    })),
  ]
  const first = usable.find(c => c.kind === preferred && !c.blocked)
  const ordered = first ? [first, ...usable.filter(c => c !== first)] : usable
  // Until the look for installed CLIs is back, nothing is called missing.
  return found === null ? ordered : [...ordered, ...PRESETS.filter(p => !found.found[p.bin]).map(p => preset(p, false))]
}

// The picker's filter: by name, id or command, ignoring case and spaces.
export function matchesAgent(choice: Pick<AgentChoice, 'kind' | 'label'>, query: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '')
  return q === '' || choice.label.toLowerCase().replace(/\s+/g, '').includes(q) || choice.kind.includes(q)
}

// The terminals and how to open one. onOpened: a terminal just made (the app shows it).
// slotFolder: where a Claude on a ccr slot opens, when the person picked a slot (TopBar); null asks.
export function useTerminals({ onFolder, onOpened, slotFolder }: { onFolder: (cwd: string) => void; onOpened: (term: TermInfo) => void; slotFolder: () => string | null }) {
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [found, setFound] = useState<AgentDetect | null>(null)
  const [error, setError] = useState('')

  // Settings can look for installed CLIs again; the picker takes what it found.
  useEffect(() => {
    void window.ide.detectAgents?.().then(setFound)
    const again = (event: Event) => setFound((event as CustomEvent<AgentDetect>).detail)
    window.addEventListener(AGENTS_FOUND, again)
    return () => window.removeEventListener(AGENTS_FOUND, again)
  }, [])

  useEffect(() => {
    void window.ide.termList().then(setTerms)
    return window.ide.onTermExit(event =>
      setTerms(list => list.map(t => (t.id === event.id ? { ...t, alive: false, exitCode: event.exitCode } : t))),
    )
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(TERMS_CHANGED, { detail: terms }))
  }, [terms])

  const latest = useRef({ onFolder, onOpened, slotFolder })
  latest.current = { onFolder, onOpened, slotFolder }
  const openIn = useCallback(async (cwd: string | null, kind = 'claude', slot?: number, resume?: string) => {
    setError('')
    const folder = cwd || (await window.ide.pickFolder())
    if (!folder) return null
    // A first size from the window; the view fits the terminal to its box once it shows.
    const cols = Math.max(40, Math.floor((window.innerWidth - 320) / 8))
    const rows = Math.max(10, Math.floor((window.innerHeight - 260) / 17))
    const made =
      kind === 'claude' || kind === 'shell'
        ? await window.ide.termOpen(folder, kind === 'claude', cols, rows, slot, resume)
        : await window.ide.termOpenAgent(folder, kind, cols, rows, resume)
    if ('error' in made) {
      setError(made.error)
      return null
    }
    setTerms(list => [...list, made])
    latest.current.onFolder(made.cwd)
    latest.current.onOpened(made)
    return made
  }, [])

  // A ccr slot picked in the top bar opens Claude on that slot.
  useEffect(() => {
    const on = (event: Event) => void openIn(latest.current.slotFolder(), 'claude', (event as CustomEvent<number>).detail)
    window.addEventListener(OPEN_CLAUDE_SLOT, on)
    return () => window.removeEventListener(OPEN_CLAUDE_SLOT, on)
  }, [openIn])

  // A second press while the first terminal is still starting goes to that terminal: the
  // session shows as connected only once claude is up, and two would run the same conversation.
  const resumed = useRef(new Map<string, { term: string; at: number }>())
  const termsRef = useRef(terms)
  termsRef.current = terms
  useEffect(() => {
    const on = (event: Event) => {
      // agent: the CLI the conversation was (agentHistory.ts); Claude Code when left out.
      const { cwd, session, agent = 'claude' } = (event as CustomEvent<{ cwd: string; session: string; agent?: string }>).detail
      const earlier = resumed.current.get(session)
      const still = earlier && Date.now() - earlier.at < RESUME_WAIT_MS ? termsRef.current.find(term => term.id === earlier.term && term.alive) : undefined
      if (still) return latest.current.onOpened(still)
      void openIn(cwd, agent, undefined, session).then(made => {
        if (made) resumed.current.set(session, { term: made.id, at: Date.now() })
      })
    }
    window.addEventListener(RESUME_SESSION, on)
    return () => window.removeEventListener(RESUME_SESSION, on)
  }, [openIn])

  const close = useCallback(async (id: string) => {
    await window.ide.termClose(id)
    setTerms(list => list.filter(t => t.id !== id))
  }, [])

  return { terms, found, error, clearError: () => setError(''), openIn, close }
}

// Every terminal, mounted once; only the one the session view shows is visible.
export function TerminalStage({ terms, shown, themeKey }: { terms: TermInfo[]; shown: string | null; themeKey: string }) {
  return (
    <div className="terminal-stage" hidden={shown === null}>
      {terms.map(term => (
        <TerminalView key={term.id} id={term.id} visible={term.id === shown} themeKey={themeKey} />
      ))}
    </div>
  )
}
