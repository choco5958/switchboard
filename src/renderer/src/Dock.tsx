import { useEffect, useId, useRef, useState } from 'react'
import type { AgentDetect, BridgeState, Task, TermInfo } from '../../shared/types'
import { projectOfCwd, type ProjectInfo } from '../../shared/projects'
import { CLAUDE_MIN, olderThan, PRESETS, type AgentTag, type CustomAgent } from '../../shared/agents'
import { TerminalView } from './TerminalView'
import { LogLines } from './parts'
import { Badge, Button, EmptyState, IconButton, Input, Menu, MenuItem, TabList, cx } from './ui'
import { composing } from './ime'
import { OPEN_CLAUDE_SLOT } from '../../shared/ccr'
import { t } from '../../shared/i18n'

const HEIGHT_KEY = 'claude-ide:dock-height'
// Low enough that a task's graph stays in view on a 1440x900 window; a dragged height is kept.
export const DOCK_HEIGHT = 200

function savedHeight(): number {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || DOCK_HEIGHT
  } catch {
    return DOCK_HEIGHT
  }
}

export const AGENTS_FOUND = 'switchboard:agents-found'
// Another screen asks for one terminal (detail: its id), such as the task view's "go to terminal";
// and the dock tells whoever listens which terminals it has (detail: TermInfo[]) as they change.
export const SHOW_TERMINAL = 'switchboard:show-terminal'
export const TERMS_CHANGED = 'switchboard:terms-changed'
const CLOSE_ARMED_MS = 3000

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

// The bottom dock: the work log and the terminals of the project in view.
// Every terminal stays mounted; switching projects only hides them.
export function Dock({
  events,
  tasks,
  scope,
  projects,
  themeKey,
  logShown,
  emptyLog = t('dock.emptyLog'),
  onExpandLog,
  onFolder,
  agents = {},
  stalledTerms = new Set<string>(),
  customs = [],
  showOthers = true,
  defaultAgent,
  onDefaultAgent = () => undefined,
}: {
  events: BridgeState['events']
  tasks: Task[]
  scope: string | null
  projects: ProjectInfo[]
  themeKey: string
  logShown: boolean // the full log page is open, so the dock's log would show it twice
  emptyLog?: string
  onExpandLog: () => void
  onFolder: (cwd: string) => void
  agents?: Record<string, AgentTag> // session id to its agent badge, for the log
  stalledTerms?: Set<string> // terminals whose session's turn shows no activity
  customs?: CustomAgent[] // the person's own agent CLIs (settings)
  showOthers?: boolean // settings: offer agent CLIs other than Claude
  defaultAgent?: string // the agent the main + button opens (the last one picked)
  onDefaultAgent?: (kind: string) => void
}) {
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [active, setActive] = useState<string>('log')
  const [height, setHeight] = useState(savedHeight)
  const [folded, setFolded] = useState(false)
  // Which button opened the folder menu: its entries open that kind of terminal.
  const [menu, setMenu] = useState<null | string>(null)
  // The agent picker (the ▾ beside + agent), its filter and the row the keys are on.
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  // The known CLIs not installed here stay folded until asked for, or until the filter names one.
  const [showMissing, setShowMissing] = useState(false)
  const [found, setFound] = useState<AgentDetect | null>(null)
  const autoFolded = useRef(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [error, setError] = useState('')
  // A slot chosen in the top bar while no project is in view: the folder menu then opens Claude on it.
  const [pickSlot, setPickSlot] = useState<number | undefined>()
  const body = useRef<HTMLDivElement>(null)
  const newBox = useRef<HTMLDivElement>(null)
  const logBox = useRef<HTMLDivElement>(null)
  // The agent picker hands focus back to its ▾ button when it closes from the keyboard.
  const pickButton = useRef<HTMLButtonElement>(null)
  const listId = useId()

  // Settings can look for installed CLIs again; the dock takes what it found.
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
  useEffect(() => {
    const show = (event: Event) => {
      setActive((event as CustomEvent<string>).detail)
      setFolded(false)
    }
    window.addEventListener(SHOW_TERMINAL, show)
    return () => window.removeEventListener(SHOW_TERMINAL, show)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height))
    } catch {
      // per-viewer convenience only
    }
  }, [height])

  // New log lines arrive at the bottom; keep them in sight.
  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight })
  }, [events.length, active, folded])

  // Terminals belong to a project by folder; the main process names them by folder name only.
  const projectOf = (t: TermInfo) => projectOfCwd(projects, t.cwd) ?? t.project
  const shown = terms.filter(t => scope === null || projectOf(t) === scope)
  // A terminal of another project is hidden; fall back to the log.
  const current = active === 'log' || shown.some(t => t.id === active) ? active : 'log'

  // While the full log page is open, a dock showing the same log folds away, and comes back after.
  useEffect(() => {
    if (logShown && current === 'log' && !folded) {
      autoFolded.current = true
      setFolded(true)
    } else if (!logShown && autoFolded.current) {
      autoFolded.current = false
      setFolded(false)
    }
  }, [logShown])

  const openIn = async (cwd: string | null, kind = 'claude', slot?: number) => {
    setMenu(null)
    setPickSlot(undefined)
    setError('')
    const folder = cwd || (await window.ide.pickFolder())
    if (!folder) return
    const box = body.current
    const cols = box ? Math.floor(box.clientWidth / 8) : 100
    const rows = box ? Math.floor(box.clientHeight / 17) : 20
    const made =
      kind === 'claude' || kind === 'shell'
        ? await window.ide.termOpen(folder, kind === 'claude', cols, rows, slot)
        : await window.ide.termOpenAgent(folder, kind, cols, rows)
    if ('error' in made) return setError(made.error)
    setTerms(list => [...list, made])
    setActive(made.id)
    setFolded(false)
    onFolder(made.cwd)
  }

  const scoped = scope === null ? null : projects.find(p => p.name === scope)
  // The listener sees the latest scope through a ref, so it is attached once.
  const openSlot = useRef<(slot: number) => void>(() => undefined)
  openSlot.current = slot => {
    if (scoped?.cwd) void openIn(scoped.cwd, 'claude', slot)
    else {
      setPickSlot(slot)
      setMenu('claude')
    }
  }
  useEffect(() => {
    const on = (event: Event) => openSlot.current((event as CustomEvent<number>).detail)
    window.addEventListener(OPEN_CLAUDE_SLOT, on)
    return () => window.removeEventListener(OPEN_CLAUDE_SLOT, on)
  }, [])
  const choices = agentChoices(found, customs, showOthers, defaultAgent)
  const main = choices[0]!
  const missingCount = choices.filter(c => !c.installed).length
  const listed = choices.filter(c => matchesAgent(c, query) && (c.installed || showMissing || query.trim() !== ''))
  const shell = { kind: 'shell', menuTitle: t('dock.menuShell') }
  const menuTitle = (kind: string) => (kind === 'shell' ? shell.menuTitle : choices.find(c => c.kind === kind)?.menuTitle)
  // Opens an agent (or the shell) in the project in view, or asks for the folder first.
  const launch = (choice: { kind: string; warn?: string; blocked?: boolean; title?: string; installed?: boolean }) => {
    setPicking(false)
    setPickSlot(undefined)
    setError(choice.installed === false ? (choice.title ?? '') : (choice.warn ?? ''))
    if (choice.blocked) return
    if (choice.kind !== 'shell' && choice.kind !== defaultAgent) onDefaultAgent(choice.kind)
    if (scoped?.cwd) void openIn(scoped.cwd, choice.kind)
    else setMenu(choice.kind)
  }

  // A Close? left armed goes back to × after a few seconds, so a later press never closes at once.
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(null), CLOSE_ARMED_MS)
    return () => clearTimeout(timer)
  }, [closing])

  // The agent picker closes on a click outside it or on Esc; Esc puts focus back on its button.
  // (The folder menu is a <Menu>, which does the same itself.)
  const closePicker = (refocus: boolean) => {
    setPicking(false)
    if (refocus) pickButton.current?.focus()
  }
  useEffect(() => {
    if (!picking) return
    const outside = (event: MouseEvent) => {
      if (!newBox.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [picking])

  const close = async (id: string) => {
    const term = terms.find(t => t.id === id)
    // A running terminal needs a second press, as closing it ends the program in it.
    if (term?.alive && closing !== id) return setClosing(id)
    setClosing(null)
    await window.ide.termClose(id)
    setTerms(list => list.filter(t => t.id !== id))
    if (active === id) setActive('log')
  }

  const drag = (event: React.MouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startH = height
    const move = (e: MouseEvent) => setHeight(Math.min(window.innerHeight - 160, Math.max(120, startH + startY - e.clientY)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <footer className={`dock ${folded ? 'folded' : ''}`} style={folded ? undefined : { height }}>
      {!folded && <div className="dock-handle" onMouseDown={drag} title={t('dock.resize')} />}
      <div className="dock-head">
        <TabList
          label={t('dock.tabsLabel')}
          className="dock-tabs"
          active={current}
          onSelect={setActive}
          items={[
            { key: 'log', label: t('dock.log') },
            ...shown.map(term => ({
              key: term.id,
              title: term.cwd,
              className: term.alive ? undefined : 'dead',
              label: (
                <>
                  {scope === null && <span className="quiet">{projectOf(term)} </span>}
                  {term.title}
                  {!term.alive && <span className="quiet"> {t('dock.ended')}</span>}
                  {term.alive && stalledTerms.has(term.id) && (
                    <span className="stalled-mark" title={t('task.stalledTitle')}>
                      {' '}
                      {t('task.stalled')}
                    </span>
                  )}
                </>
              ),
              close: {
                label: t('dock.closeTerm', { title: term.title }),
                title: term.alive ? t('dock.closeArmedTitle') : undefined,
                content: closing === term.id ? t('dock.closeConfirm') : undefined,
                className: closing === term.id ? 'armed' : undefined,
                onBlur: () => setClosing(armed => (armed === term.id ? null : armed)),
                onClose: () => void close(term.id),
              },
            })),
          ]}
        />
        <div className="dock-new" ref={newBox}>
          <div className="dock-split">
            <button type="button" className={cx('dock-add', main.warn && 'add-warn')} title={main.title} onClick={() => launch(main)}>
              + {main.label === 'Claude Code' ? 'Claude' : main.label}
            </button>
            {choices.length > 1 && (
              <IconButton
                ref={pickButton}
                icon="chevronDown"
                size="sm"
                className="dock-pick"
                label={t('dock.pickAgent')}
                aria-haspopup="listbox"
                aria-expanded={picking}
                onClick={() => {
                  setMenu(null)
                  setQuery('')
                  setCursor(0)
                  setShowMissing(false)
                  setPicking(open => !open)
                }}
              />
            )}
          </div>
          <button type="button" className="dock-add" title={t('dock.newShellTitle')} onClick={() => launch(shell)}>
            {t('dock.newShell')}
          </button>
          {picking && (
            // A filter field that drives a list (a combobox): the arrows move the highlight in the
            // list while typing stays in the field, Enter opens the highlighted agent.
            <div className="menu dock-menu agent-picker">
              <Input
                compact
                className="agent-filter"
                autoFocus
                role="combobox"
                aria-label={t('dock.findAgent')}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={listed[cursor] ? `${listId}-${cursor}` : undefined}
                placeholder={t('dock.findAgent')}
                value={query}
                onChange={e => {
                  setQuery(e.target.value)
                  setCursor(0)
                }}
                onKeyDown={e => {
                  if (composing(e)) return
                  if (e.key === 'ArrowDown') setCursor(c => Math.min(listed.length - 1, c + 1))
                  else if (e.key === 'ArrowUp') setCursor(c => Math.max(0, c - 1))
                  else if (e.key === 'Enter' && listed[cursor]) launch(listed[cursor]!)
                  else if (e.key === 'Escape') closePicker(true)
                  else return
                  e.preventDefault()
                  e.stopPropagation()
                }}
              />
              <div id={listId} role="listbox" aria-label={t('dock.pickAgent')} className="agent-options">
                {listed.map((c, i) => (
                  <div
                    key={c.kind}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === cursor}
                    className={cx('row agent-row', i === cursor && 'on', !c.installed && 'missing')}
                    title={c.title}
                    onMouseEnter={() => setCursor(i)}
                    // The field keeps focus: a press on a row must not take it away first.
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => launch(c)}
                  >
                    <span className="dock-menu-name">{c.label}</span>
                    {c.kind === main.kind && c.installed && (
                      <Badge shape="pill" tone="accent" className="small agent-default">{t('dock.agentDefault')}</Badge>
                    )}
                    <span className="spacer" />
                    <span className={cx('agent-via small', c.warn && 'warn')}>{c.installed ? t(`dock.via.${c.via}`) : t('dock.notInstalled')}</span>
                  </div>
                ))}
              </div>
              {listed.length === 0 && <EmptyState className="small agent-none">{t('dock.noAgentMatch')}</EmptyState>}
              {missingCount > 0 && !showMissing && query.trim() === '' && (
                <Button variant="link" size="sm" className="agent-more" onClick={() => setShowMissing(true)}>
                  {t('dock.showMissing', { n: missingCount })}
                </Button>
              )}
            </div>
          )}
          {menu && (
            <Menu label={menuTitle(menu) ?? ''} className={`dock-menu menu-${menu === 'claude' || menu === 'shell' ? menu : 'agent'}`} within={newBox} onClose={() => setMenu(null)}>
              <div className="menu-title quiet small">{menuTitle(menu)}</div>
              {projects
                .filter(p => p.cwd)
                .map(p => (
                  <MenuItem key={p.name} title={p.cwd} onSelect={() => void openIn(p.cwd, menu, pickSlot)}>
                    <span className="dock-menu-name">{p.name}</span>
                    <span className="quiet small mono dock-menu-path">{p.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
                  </MenuItem>
                ))}
              <MenuItem onSelect={() => void openIn(null, menu, pickSlot)}>{t('dock.otherFolder')}</MenuItem>
            </Menu>
          )}
        </div>
        {error && <span className="error small">{error}</span>}
        <span className="spacer" />
        {current === 'log' && (
          <Button variant="ghost" size="sm" className="dock-action" onClick={onExpandLog} title={t('dock.expandLogTitle')}>
            {t('dock.expandLog')}
          </Button>
        )}
        <IconButton
          icon="collapse"
          size="sm"
          className={cx('dock-fold', folded && 'is-folded')}
          label={folded ? t('dock.unfold') : t('dock.fold')}
          onClick={() => {
            autoFolded.current = false
            setFolded(f => !f)
          }}
        />
      </div>
      <div className="dock-body" ref={body} style={{ display: folded ? 'none' : undefined }}>
        {current === 'log' && (
          <div className="worklog-body" ref={logBox}>
            <LogLines events={events.slice(-200)} tasks={tasks} empty={emptyLog} agents={agents} />
          </div>
        )}
        {terms.map(t => (
          <TerminalView key={t.id} id={t.id} visible={!folded && current === t.id} themeKey={themeKey} />
        ))}
      </div>
    </footer>
  )
}
