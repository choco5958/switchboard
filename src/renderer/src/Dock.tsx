import { useEffect, useRef, useState } from 'react'
import type { AgentDetect, BridgeState, Task, TermInfo } from '../../shared/types'
import { projectOfCwd, type ProjectInfo } from '../../shared/projects'
import { CLAUDE_MIN, olderThan, PRESETS, type AgentTag, type CustomAgent } from '../../shared/agents'
import { Icon } from './Icons'
import { TerminalView } from './TerminalView'
import { LogLines } from './parts'
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

// What the dock can open: Claude, a plain shell, and every other agent CLI that is
// installed or the person added. kind is 'claude', 'shell' or the agent's id.
// warn: why this one may not work (Claude Code missing or too old), shown on the button.
type Launcher = { kind: string; text: string; title: string; menuTitle: string; warn?: string; blocked?: boolean }

export function launchers(found: AgentDetect | null, customs: readonly CustomAgent[], showOthers = true): Launcher[] {
  const missing = found !== null && !found.found.claude
  const old = !missing && found?.claudeVersion && olderThan(found.claudeVersion, CLAUDE_MIN) ? found.claudeVersion : null
  const warn = missing ? t('dock.claudeMissing') : old ? t('dock.claudeOld', { version: old, need: CLAUDE_MIN }) : undefined
  const base: Launcher[] = [
    { kind: 'claude', text: '+ Claude', title: warn ?? t('dock.newClaudeTitle'), menuTitle: t('dock.menuClaude'), warn, blocked: missing },
    { kind: 'shell', text: t('dock.newShell'), title: t('dock.newShellTitle'), menuTitle: t('dock.menuShell') },
  ]
  if (!showOthers) return base
  return [
    ...base,
    ...PRESETS.filter(p => found?.found[p.bin]).map(p => ({
      kind: p.id,
      text: `+ ${p.label}`,
      title: t(p.mcp ? 'dock.agentTitle' : 'dock.agentPlainTitle', { command: p.bin }),
      menuTitle: t('dock.menuAgent', { label: p.label }),
    })),
    ...customs.map(c => ({
      kind: c.id,
      text: `+ ${c.name}`,
      title: t(c.mcp === 'none' ? 'dock.agentPlainTitle' : 'dock.agentTitle', { command: c.command }),
      menuTitle: t('dock.menuAgent', { label: c.name }),
    })),
  ]
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
}) {
  const [terms, setTerms] = useState<TermInfo[]>([])
  const [active, setActive] = useState<string>('log')
  const [height, setHeight] = useState(savedHeight)
  const [folded, setFolded] = useState(false)
  // Which button opened the folder menu: its entries open that kind of terminal.
  const [menu, setMenu] = useState<null | string>(null)
  const [found, setFound] = useState<AgentDetect | null>(null)
  const autoFolded = useRef(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [error, setError] = useState('')
  // A slot chosen in the top bar while no project is in view: the folder menu then opens Claude on it.
  const [pickSlot, setPickSlot] = useState<number | undefined>()
  const body = useRef<HTMLDivElement>(null)
  const logBox = useRef<HTMLDivElement>(null)

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
  const all = launchers(found, customs, showOthers)

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
        <button className={`dock-tab ${current === 'log' ? 'on' : ''}`} onClick={() => setActive('log')}>
          {t('dock.log')}
        </button>
        {shown.map(term => (
          <div key={term.id} className={`dock-tab ${current === term.id ? 'on' : ''} ${term.alive ? '' : 'dead'}`} title={term.cwd} onClick={() => setActive(term.id)}>
            {scope === null && <span className="quiet">{projectOf(term)} </span>}
            {term.title}
            {!term.alive && <span className="quiet"> {t('dock.ended')}</span>}
            {term.alive && stalledTerms.has(term.id) && (
              <span className="stalled-mark" title={t('task.stalledTitle')}> {t('task.stalled')}</span>
            )}
            <button
              className={`tab-close ${closing === term.id ? 'armed' : ''}`}
              title={term.alive ? t('dock.closeArmedTitle') : t('common.close')}
              onClick={event => {
                event.stopPropagation()
                void close(term.id)
              }}
            >
              {closing === term.id ? t('dock.closeConfirm') : '×'}
            </button>
          </div>
        ))}
        <div className="dock-new">
          {all.map(l => (
            <button
              key={l.kind}
              className={`dock-tab add ${l.kind === 'claude' || l.kind === 'shell' ? '' : 'add-agent'} ${l.warn ? 'add-warn' : ''}`}
              title={l.title}
              onClick={() => {
                setPickSlot(undefined)
                if (l.warn) setError(l.warn)
                if (l.blocked) return
                if (scoped?.cwd) void openIn(scoped.cwd, l.kind)
                else setMenu(m => (m === l.kind ? null : l.kind))
              }}
            >
              {l.text}
            </button>
          ))}
          {menu && (
            <div className={`dock-menu menu-${menu === 'claude' || menu === 'shell' ? menu : 'agent'}`}>
              <div className="dock-menu-title quiet small">{all.find(l => l.kind === menu)?.menuTitle}</div>
              {projects
                .filter(p => p.cwd)
                .map(p => (
                  <button key={p.name} title={p.cwd} onClick={() => void openIn(p.cwd, menu, pickSlot)}>
                    <span className="dock-menu-name">{p.name}</span>
                    <span className="quiet small mono dock-menu-path">{p.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
                  </button>
                ))}
              <button onClick={() => void openIn(null, menu, pickSlot)}>{t('dock.otherFolder')}</button>
            </div>
          )}
        </div>
        {error && <span className="error small">{error}</span>}
        <span className="spacer" />
        {current === 'log' && (
          <button className="dock-action" onClick={onExpandLog} title={t('dock.expandLogTitle')}>
            {t('dock.expandLog')}
          </button>
        )}
        <button
          className={`dock-fold ${folded ? 'is-folded' : ''}`}
          title={folded ? t('dock.unfold') : t('dock.fold')}
          aria-label={folded ? t('dock.unfold') : t('dock.fold')}
          onClick={() => {
            autoFolded.current = false
            setFolded(f => !f)
          }}
        >
          <Icon name="collapse" size={14} />
        </button>
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
