import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Approval, BridgeState, CommandKind, GraphNode, Question, TermInfo } from '../../shared/types'
import { Palette, type PaletteItem } from './Palette'
import { PropsPanel } from './PropsPanel'
import { DECISION_KEYS_KEY, QuestionCard } from './QuestionCard'
import { TaskView } from './TaskView'
import { StatusFooter } from './TopBar'
import { queueOf, reachOf, resumable, taskFacts, type Attention } from './model'
import { ArchivePage } from './pages/ArchivePage'
import { DebugPage } from './pages/DebugPage'
import { BROWSER_LAN_KEY } from './agentBrowser'
import { DebugPanel } from './pages/DebugPanel'
import { GalleryPage } from './pages/GalleryPage'
import { HomePage } from './pages/HomePage'
import { LinearPage } from './pages/LinearPage'
import { LogPage } from './pages/LogPage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { HIDDEN_KEY, hiddenProjects, isRunning, nameForFolder, pickSession, projectFolders, projectOfCwd, projectsOf, savedProjects } from '../../shared/projects'
import { SHOW_TERMINAL, TerminalStage, agentChoices, useTerminals } from './Dock'
import { History, Toast, ToastProvider, useToastList } from './parts'
import { Button, Notice } from './ui'
import { resendLeft, waitingIds } from './outbox'
import { stalledSessions } from '../../shared/stall'
import { limitedUntil } from '../../shared/limit'
import { CUSTOM_AGENTS_KEY, SHOW_OTHER_AGENTS_KEY, agentLabel, agentTags, customAgents, showOtherAgents } from '../../shared/agents'
import { HOME, tabKey, type Tab } from './tabs'
import { applyTheme } from './theme'
import { installSettingSaver, postSetting, saveSetting, settle, withPending, type Pending } from './settings'
import { LOCALE_TAG, resolveLang, setLang, stageLabel, t } from '../../shared/i18n'
import { waitCount, waitParts } from './waiting'
import { isHelpKey, isPaletteKey } from './shortcuts'
import { OPEN_SETTINGS, ShortcutHelp, scrollToSection } from './flows'
import { sessionRows, termKey, type SessionRow } from './sessions'
import { Sidebar, rowStateText, type NavItem } from './Sidebar'
import { SessionView, type NextUp } from './SessionView'
import { Incoming } from './Incoming'

const EMPTY: BridgeState = {
  sessions: [],
  live: [],
  tasks: [],
  questions: [],
  answeredCount: 0,
  events: [],
  nodes: [],
  archived: [],
  agents: [],
  commands: [],
  settings: {},
}

// What the main area shows: home, one session (its sidebar row's key), or another screen.
type Route = Tab | { kind: 'session'; key: string }
const ROUTE_KEY = 'claude-ide:route'

// The component gallery is for building the IDE: shown in development or when the settings ask for it.
export function devMenuShown(settings: Record<string, unknown>): boolean {
  return import.meta.env.DEV || settings.devMenu === true
}

function loadRoute(): Route {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null')
    return saved && typeof saved === 'object' && typeof (saved as Route).kind === 'string' ? (saved as Route) : HOME
  } catch {
    return HOME
  }
}

const routeKey = (route: Route): string => (route.kind === 'session' ? route.key : tabKey(route))

export function App() {
  const [bridgeState, setState] = useState<BridgeState>(EMPTY)
  // Settings writes still on their way to the bridge, shown at once (settings.ts).
  const [unsaved, setUnsaved] = useState<Pending>({})
  const pendingRef = useRef<Pending>({})
  const state = useMemo(
    () => (Object.keys(unsaved).length === 0 ? bridgeState : { ...bridgeState, settings: withPending(bridgeState.settings, unsaved) }),
    [bridgeState, unsaved],
  )
  const stateRef = useRef(state)
  stateRef.current = state
  const [loaded, setLoaded] = useState(false)
  // null until the first check, so the app never flashes the disconnected notice on start.
  const [connected, setConnected] = useState<boolean | null>(null)
  // The bridge stays down: after a while, why (the log's last line), with a way to open the log.
  const [problem, setProblem] = useState<{ log: string; last: string } | null>(null)
  useEffect(() => {
    if (connected !== false) {
      setProblem(null)
      return
    }
    const timer = setInterval(() => void window.ide.bridgeProblem().then(setProblem), 15_000)
    return () => clearInterval(timer)
  }, [connected])
  // Answers an earlier run kept in the outbox but never sent (a forced quit): they go once the
  // bridge answers. One it already has (409) or no longer knows (404) is done with too.
  useEffect(() => {
    if (!connected) return
    void resendLeft(async (id, draft) => {
      const reply = await window.ide.answer(id, draft.choice, draft.memo)
      return reply.ok || reply.status === 409 || reply.status === 404
    })
  }, [connected])
  const [route, setRoute] = useState<Route>(loadRoute)
  const [palette, setPalette] = useState(false)
  const { toasts, show: toast, dismiss } = useToastList()
  const [live, setLive] = useState(true)
  const liveRef = useRef(true)
  // The notification click arrives through an effect that runs once; the ref keeps it calling the latest openQuestion.
  const openQuestionRef = useRef<(id: number) => void>(() => undefined)
  const [pickedNode, setPickedNode] = useState<GraphNode | null>(null)
  // Feature area: UI language. Set before the children render, so one render redraws every string.
  const lang = resolveLang(state.settings.lang, navigator.language)
  setLang(lang)
  useEffect(() => {
    document.documentElement.lang = LOCALE_TAG[lang]
  }, [lang])
  const NO_SESSION = t('app.noSession')
  const toggleLive = () => {
    liveRef.current = !live
    setLive(!live)
    if (!live) void refresh()
  }

  // Busy sessions send many changes a second: one read at a time, and one more after it for
  // whatever came in meanwhile, instead of a full read and redraw for each.
  const reading = useRef(false)
  const readAgain = useRef(false)
  const refresh = useCallback(async () => {
    if (reading.current) {
      readAgain.current = true
      return
    }
    reading.current = true
    try {
      do {
        readAgain.current = false
        const next = await window.ide.state()
        if (next) {
          setState(next)
          setLoaded(true)
        }
      } while (readAgain.current)
    } finally {
      reading.current = false
    }
  }, [])

  // A settings write reads the settings back whether or not Live is paused: a paused screen keeps
  // its tasks and questions as they were, and takes only the new settings.
  const readSettings = useCallback(async () => {
    const next = await window.ide.state()
    if (!next) return
    setState(current => (liveRef.current ? next : { ...current, settings: next.settings }))
    setLoaded(true)
  }, [])
  const writeSetting = useCallback(
    async (key: string, value: unknown) => {
      pendingRef.current = { ...pendingRef.current, [key]: value }
      setUnsaved(pendingRef.current)
      const reply = await postSetting(key, value)
      if (reply.ok) await readSettings()
      pendingRef.current = settle(pendingRef.current, key, value)
      setUnsaved(pendingRef.current)
      return reply
    },
    [readSettings],
  )
  useEffect(() => {
    installSettingSaver(writeSetting)
    return () => installSettingSaver(null)
  }, [writeSetting])
  // A change built on the latest value of a setting, writes still on their way included, so two
  // quick changes in a row both stay.
  const updateSetting = useCallback(
    (key: string, change: (current: unknown) => unknown) => {
      const current = key in pendingRef.current ? pendingRef.current[key] : stateRef.current.settings[key]
      return writeSetting(key, change(current))
    },
    [writeSetting],
  )

  useEffect(() => {
    void refresh()
    void window.ide.connected().then(setConnected)
    const offChange = window.ide.onChange(() => {
      if (liveRef.current) void refresh()
    })
    const offConnection = window.ide.onConnection(setConnected)
    const offNotify = window.ide.onNotifyOpen(id => openQuestionRef.current(id))
    return () => {
      offNotify()
      offChange()
      offConnection()
    }
  }, [refresh])

  useEffect(() => {
    try {
      localStorage.setItem(ROUTE_KEY, JSON.stringify(route))
    } catch {
      // per-viewer convenience only
    }
  }, [route])

  useEffect(() => {
    applyTheme(state.settings.theme)
  }, [state.settings.theme])

  // The shortcut list (? or ⌘/); shortcuts.ts names every key the app listens for.
  const [help, setHelp] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteKey(event)) {
        event.preventDefault()
        setPalette(open => !open)
      } else if (isHelpKey(event) && !event.defaultPrevented) {
        event.preventDefault()
        setHelp(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = useCallback((tab: Route) => setRoute(tab), [])
  // The settings screen, scrolled to one of its sections (the update chip, the first run's steps).
  const openSettingsAt = useCallback(
    (id: string) => {
      open({ kind: 'settings' })
      scrollToSection(id)
    },
    [open],
  )
  useEffect(() => {
    const go = (event: Event) => openSettingsAt(String((event as CustomEvent<string>).detail))
    window.addEventListener(OPEN_SETTINGS, go)
    return () => window.removeEventListener(OPEN_SETTINGS, go)
  }, [openSettingsAt])

  const saved = useMemo(() => savedProjects(state.settings.projects), [state.settings.projects])
  // Every project, for names and folders; the sidebar leaves out the ones taken off the list.
  const allProjects = useMemo(() => projectsOf(state, saved), [state, saved])
  const hidden = useMemo(() => hiddenProjects(state.settings[HIDDEN_KEY]), [state.settings])
  // By name, so a project keeps its place in the sidebar however its sessions come and go.
  const projects = useMemo(() => allProjects.filter(p => !hidden.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name)), [allProjects, hidden])
  const hiddenPending = useMemo(() => Object.fromEntries(allProjects.filter(p => hidden.includes(p.name)).map(p => [p.name, p.pending])), [allProjects, hidden])
  const folders = useMemo(() => projectFolders(state.settings.projectFolders), [state.settings])
  // Feature area: agent CLIs other than Claude Code. Badges by session, and the person's own CLIs.
  const customs = useMemo(() => customAgents(state.settings[CUSTOM_AGENTS_KEY]), [state.settings])
  const tags = useMemo(() => agentTags(state.sessions, customs), [state.sessions, customs])

  // A folder a terminal opened in becomes a project of its own in the sidebar.
  const addProject = useCallback(
    async (cwd: string) => {
      // A folder taken off the list comes back when it is added again.
      const name = nameForFolder(allProjects, cwd)
      if (hidden.includes(name)) await updateSetting(HIDDEN_KEY, current => hiddenProjects(current).filter(h => h !== name))
      if (saved.some(p => p.cwd === cwd)) return
      await updateSetting('projects', current => {
        const list = savedProjects(current)
        return list.some(p => p.cwd === cwd) ? list : [...list, { name, cwd }]
      })
    },
    [saved, allProjects, hidden, updateSetting],
  )
  const pickProject = async () => {
    const cwd = await window.ide.pickFolder()
    if (cwd) await addProject(cwd)
  }

  // The app's terminals. One just opened (+, resume, a ccr slot) shows at once.
  const routeRef = useRef(route)
  routeRef.current = route
  const rowsRef = useRef<SessionRow[]>([])
  const terminals = useTerminals({
    onFolder: cwd => void addProject(cwd),
    onOpened: (term: TermInfo) => setRoute({ kind: 'session', key: termKey(term.id) }),
    slotFolder: () => {
      const current = routeRef.current
      return current.kind === 'session' ? (rowsRef.current.find(r => r.key === current.key)?.cwd ?? null) : null
    },
  })
  useEffect(() => {
    if (terminals.error) toast(terminals.error, 'bad')
  }, [terminals.error, toast])
  // The task view's "go to terminal" shows that terminal's session.
  useEffect(() => {
    const show = (event: Event) => setRoute({ kind: 'session', key: termKey(String((event as CustomEvent<string>).detail)) })
    window.addEventListener(SHOW_TERMINAL, show)
    return () => window.removeEventListener(SHOW_TERMINAL, show)
  }, [])

  // A stall is time passing without events, so the check runs on a clock as well.
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const stalled = useMemo(
    () => new Set(stalledSessions(state.activity ?? {}, state.live ?? [], clockNow)),
    [state.activity, state.live, clockNow],
  )
  const limited = useMemo(
    () => new Set(state.sessions.filter(s => limitedUntil(s.usage, s.last_seen, clockNow) !== null).map(s => s.id)),
    [state.sessions, clockNow],
  )
  // Counted once per bridge state, not once per task on every render (model.ts taskFacts).
  const facts = useMemo(
    () => taskFacts({ tasks: state.tasks, questions: state.questions, nodes: state.nodes, sessions: state.sessions, live: state.live }, stalled, limited, isRunning),
    [state.tasks, state.questions, state.nodes, state.sessions, state.live, stalled, limited],
  )
  const attentionOfTask = (task: BridgeState['tasks'][number]): Attention | null => facts.get(task.id)?.attention ?? null
  // The sidebar's rows (sessions.ts): every app terminal and every session that still matters.
  const rows = useMemo(
    () =>
      sessionRows({
        sessions: state.sessions,
        live: state.live ?? [],
        tasks: state.tasks,
        questions: state.questions,
        approvals: state.approvals ?? [],
        terms: terminals.terms,
        stalled,
        limited,
        projectOf: (cwd, fallback) => projectOfCwd(allProjects, cwd) ?? fallback,
      }),
    [state.sessions, state.live, state.tasks, state.questions, state.approvals, terminals.terms, stalled, limited, allProjects],
  )
  rowsRef.current = rows
  // The one "waiting for me" count (waiting.ts): home in the sidebar and the palette.
  const wait = waitCount(state, attentionOfTask)
  const reachOfQuestion = (q: Question) => reachOf(state.sessions.find(s => s.id === q.session_id), state.live ?? [])
  // A gone Claude session to open again; none while the bridge is away, as every session looks gone then.
  const resumeOf = (sessionId: string) => {
    const session = state.sessions.find(s => s.id === sessionId)
    return connected && resumable(session, state.live ?? []) ? session : undefined
  }
  const rowOfSession = (sessionId: string) => rows.find(r => r.session?.id === sessionId)
  const openRow = (row: SessionRow) => setRoute({ kind: 'session', key: row.key })
  // A question opens in its session when the sidebar has one, else on its own.
  const openQuestion = (id: number) => {
    const q = state.questions.find(one => one.id === id)
    const row = q ? rowOfSession(q.session_id) : undefined
    setRoute(row ? { kind: 'session', key: row.key } : { kind: 'question', id })
  }
  openQuestionRef.current = openQuestion
  const openTask = (id: number) => open({ kind: 'task', id })
  // Reports, syncs and Linear sends go to the session in view, else the newest one.
  const viewRow = route.kind === 'session' ? rows.find(r => r.key === route.key) : undefined
  const latestSession = useMemo(() => viewRow?.session ?? pickSession(state.sessions, null), [viewRow, state.sessions])
  const showDev = devMenuShown(state.settings)
  // Linear comes through Orca's CLI; without Orca the screen could only show an error.
  const [linearOk, setLinearOk] = useState(false)
  useEffect(() => {
    void window.ide.linearAvailable?.().then(setLinearOk, () => setLinearOk(false))
  }, [])

  const command = useCallback(
    async (kind: CommandKind, payload: Record<string, unknown> = {}, sessionId = latestSession?.id) => {
      if (!sessionId) return toast(NO_SESSION, 'bad')
      const reply = await window.ide.command(sessionId, kind, payload)
      if (!reply.ok) toast(t('app.requestFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
      return reply.ok
    },
    [latestSession, toast, NO_SESSION],
  )
  const ask = async (kind: 'report' | 'sync') => {
    const id = latestSession?.id
    if ((await command(kind)) && id) toast(t(kind === 'report' ? 'app.askedReport' : 'app.askedSync', { id: id.slice(0, 8) }))
  }
  const answerApproval = async (a: Approval, decision: 'allow' | 'deny' | 'terminal', note?: string) => {
    const reply = await window.ide.approve(a.id, decision, note)
    if (!reply.ok) toast(t('approval.answerFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }
  const launch = (cwd: string, choice: { kind: string; warn?: string; blocked?: boolean; title?: string; installed?: boolean }) => {
    if (choice.installed === false || choice.blocked) return toast(choice.title ?? choice.warn ?? '', 'bad')
    if (choice.warn) toast(choice.warn, 'info')
    if (choice.kind !== 'shell' && choice.kind !== state.settings.defaultAgent) void saveSetting('defaultAgent', choice.kind)
    void terminals.openIn(cwd, choice.kind)
  }

  // Only the done tasks; the label counts the same tasks.
  const archiveDone = useCallback(async () => {
    const reply = await window.ide.bridge('POST', '/tasks/archive-done', {})
    if (!reply.ok) return toast(t('app.archiveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
    toast(t('app.archivedDone', { n: Number(reply.json.count ?? 0) }))
  }, [toast])
  const restore = async (id: number) => {
    const reply = await window.ide.bridge('POST', `/tasks/${id}/restore`)
    toast(reply.ok ? t('app.restored') : t('app.restoreFailed', { error: String(reply.json.error ?? reply.status) }), reply.ok ? 'good' : 'bad')
  }

  const doneCount = state.tasks.filter(task => task.stage === '완료').length
  // Never connected yet: the empty lists say nothing about the data, so they say so.
  const offline = connected === false && !loaded
  const sessionHint = latestSession ? t('app.sessionHint', { id: latestSession.id.slice(0, 8), project: latestSession.project }) : undefined
  const choices = agentChoices(terminals.found, customs, showOtherAgents(state.settings[SHOW_OTHER_AGENTS_KEY]), typeof state.settings.defaultAgent === 'string' ? state.settings.defaultAgent : undefined)

  // The other screens, at the bottom of the sidebar and in the palette.
  const nav: NavItem[] = [
    { icon: 'debug' as const, label: t('rail.debug'), key: 'debug', onOpen: () => open({ kind: 'debug' }) },
    { icon: 'sessions' as const, label: t('rail.sessions'), key: 'sessions', onOpen: () => open({ kind: 'sessions' }) },
    { icon: 'history' as const, label: t('rail.history'), key: 'history', onOpen: () => open({ kind: 'history' }) },
    { icon: 'log' as const, label: t('rail.log'), key: 'log', onOpen: () => open({ kind: 'log' }) },
    { icon: 'archive' as const, label: t('rail.archive'), key: 'archive', onOpen: () => open({ kind: 'archive' }) },
    ...(linearOk ? [{ icon: 'linear' as const, label: 'Linear', key: 'linear', onOpen: () => open({ kind: 'linear' }) }] : []),
    ...(showDev ? [{ icon: 'gallery' as const, label: t('rail.gallery'), key: 'gallery', onOpen: () => open({ kind: 'gallery' }) }] : []),
  ]

  // Built only while the palette is open; a busy bridge redraws the app many times a second.
  const paletteItems = (): PaletteItem[] => [
    ...rows.map(row => ({ id: `s${row.key}`, group: t('palette.groupSession'), label: row.title, hint: [row.project, agentLabel(row.agent, customs), rowStateText(row)].filter(Boolean).join(', '), run: () => openRow(row) })),
    ...state.tasks.map(task => ({ id: `t${task.id}`, group: t('palette.groupTask'), label: task.title, hint: `${task.project}, ${stageLabel(task.stage)}`, run: () => openTask(task.id) })),
    ...projects
      .filter(p => p.cwd)
      .map(p => ({ id: `n${p.name}`, group: t('palette.groupProject'), label: t('palette.newClaude', { name: p.name }), hint: p.cwd.replace(/^\/Users\/[^/]+/, '~'), run: () => launch(p.cwd, choices[0] ?? { kind: 'claude' }) })),
    ...state.questions.map(q => ({
      id: `q${q.id}`,
      group: t('palette.groupQuestion'),
      label: `Q${q.id} ${q.question}`,
      hint: t(q.status === 'pending' ? 'palette.qPending' : q.status === 'held' ? 'palette.qHeld' : 'palette.qAnswered'),
      run: () => openQuestion(q.id),
    })),
    { id: 'p-home', group: t('palette.groupScreen'), label: t('rail.home'), hint: waitParts(wait), run: () => open(HOME) },
    ...nav.map(item => ({ id: `p${item.key}`, group: t('palette.groupScreen'), label: item.label, run: item.onOpen })),
    { id: 'p-settings', group: t('palette.groupScreen'), label: t('rail.settings'), run: () => open({ kind: 'settings' }) },
    { id: 'p-keys', group: t('palette.groupScreen'), label: t('keys.title'), hint: '?', run: () => setHelp(true) },
    {
      id: 'a-archive',
      group: t('palette.groupAction'),
      label: t('palette.archiveDone'),
      hint: t('common.count', { n: doneCount }),
      disabled: doneCount === 0 ? t('palette.noDone') : undefined,
      run: () => void archiveDone(),
    },
    { id: 'a-live', group: t('palette.groupAction'), label: live ? t('palette.pauseLive') : t('palette.resumeLive'), run: toggleLive },
    { id: 'a-report', group: t('palette.groupAction'), label: t('palette.report'), hint: sessionHint, disabled: latestSession ? undefined : NO_SESSION, run: () => void ask('report') },
    {
      id: 'a-sync',
      group: t('palette.groupAction'),
      label: t('palette.sync'),
      hint: latestSession ? t('palette.syncHint', { session: sessionHint ?? '' }) : undefined,
      disabled: latestSession ? undefined : NO_SESSION,
      run: () => void ask('sync'),
    },
  ]

  const logTasks = useMemo(() => [...state.tasks, ...state.archived], [state.tasks, state.archived])
  const peersOf = (sessionId: string) =>
    state.sessions
      .filter(s => s.id !== sessionId && (state.live ?? []).includes(s.id))
      .map(s => {
        const task = state.tasks.find(one => one.session_id === s.id && isRunning(one))
        return { id: s.id, name: s.project, label: `${s.project}${s.agent && s.agent !== 'claude' ? ` (${s.agent})` : ''}${task ? `: ${task.title}` : ''}` }
      })
  // What waits elsewhere once the session in view has nothing to answer: the oldest question, else permission ask.
  const nextUp = (current: SessionRow): NextUp | null => {
    const sending = waitingIds()
    const questions = queueOf(state.questions).pending.filter(q => !sending.has(q.id) && q.session_id !== current.session?.id)
    const asks = (state.approvals ?? []).filter(a => a.status === 'pending' && a.session_id !== current.session?.id)
    const count = questions.length + asks.length
    const q = questions[0]
    if (q) return { count, kind: 'question', title: q.question, where: rowOfSession(q.session_id)?.title ?? q.project, go: () => openQuestion(q.id) }
    const a = asks[0]
    if (!a) return null
    const row = rowOfSession(a.session_id)
    return { count, kind: 'approval', title: a.tool, where: row?.title ?? a.project, go: () => (row ? openRow(row) : open(HOME)) }
  }

  const renderPage = (page: Route) => {
    if (page.kind === 'session') {
      if (!viewRow) return null
      return (
        <SessionView
          key={viewRow.key}
          row={viewRow}
          customs={customs}
          nodes={viewRow.task ? state.nodes.filter(n => n.task_id === viewRow.task!.id) : []}
          events={state.events}
          tasks={logTasks}
          agents={tags}
          reach={viewRow.session ? reachOf(viewRow.session, state.live ?? []) : 'unknown'}
          resume={viewRow.session && !viewRow.term ? resumeOf(viewRow.session.id) : undefined}
          peers={viewRow.session ? peersOf(viewRow.session.id) : []}
          next={nextUp(viewRow)}
          keysAnywhere={state.settings[DECISION_KEYS_KEY] === true}
          onOpenTask={openTask}
          onCloseTerm={id => void terminals.close(id).then(() => setRoute(HOME))}
          onAnswerApproval={(a, decision, note) => void answerApproval(a, decision, note)}
        />
      )
    }
    if (page.kind === 'home')
      return (
        <HomePage
          state={state}
          rows={rows}
          customs={customs}
          resumeOf={resumeOf}
          onOpenRow={openRow}
          onOpenQuestion={openQuestion}
          onPickFolder={() => void pickProject()}
          onAnswerApproval={(a, decision, note) => void answerApproval(a, decision, note)}
        />
      )
    if (page.kind === 'task') {
      const task = state.tasks.find(one => one.id === page.id)
      if (!task) return null
      return (
        <TaskView
          key={task.id}
          onSelectNode={setPickedNode}
          task={task}
          agent={tags[task.session_id]}
          nodes={state.nodes.filter(n => n.task_id === task.id)}
          questions={state.questions}
          events={state.events}
          agents={state.agents.filter(a => a.session_id === task.session_id && a.task_title === task.title)}
          session={(state.live ?? []).includes(task.session_id) ? state.sessions.find(s => s.id === task.session_id) : undefined}
          resume={resumeOf(task.session_id)}
          onQuestion={openQuestion}
          onCommand={(kind, payload) => void command(kind, payload, task.session_id)}
        />
      )
    }
    if (page.kind === 'question') {
      const q = state.questions.find(one => one.id === page.id)
      if (!q) return null
      const task = state.tasks.find(one => one.session_id === q.session_id && one.title === q.task_title)
      return (
        <QuestionCard
          key={q.id}
          q={q}
          agent={tags[q.session_id]}
          sessionProject={state.sessions.find(s => s.id === q.session_id)?.project ?? q.project}
          reach={reachOfQuestion(q)}
          resume={resumeOf(q.session_id)}
          peers={peersOf(q.session_id)}
          onDone={() => open(HOME)}
          onReopen={() => openQuestion(q.id)}
          onOpenTask={task ? () => openTask(task.id) : null}
          keysAnywhere={state.settings[DECISION_KEYS_KEY] === true}
        />
      )
    }
    if (page.kind === 'history') return <History questions={state.questions} onOpen={openQuestion} />
    if (page.kind === 'archive') return <ArchivePage archived={state.archived} onRestore={id => void restore(id)} />
    if (page.kind === 'log') return <LogPage events={state.events} tasks={logTasks} agents={tags} />
    if (page.kind === 'sessions') return <SessionsPage running={state.live ?? []} />
    if (page.kind === 'linear') return <LinearPage sessions={state.sessions} />
    if (page.kind === 'settings') return <SettingsPage settings={state.settings} routines={state.routines} runs={state.routineRuns} projects={allProjects} />
    if (page.kind === 'gallery') return showDev ? <GalleryPage /> : null
    return null
  }

  // The task view lights the row of the session the task belongs to.
  const taskRow = route.kind === 'task' ? rowOfSession(state.tasks.find(one => one.id === route.id)?.session_id ?? '') : undefined
  const activeKey = route.kind === 'session' && !viewRow ? 'home' : (taskRow?.key ?? routeKey(route))
  const sessionMode = route.kind === 'session' && !!viewRow
  const watching = viewRow?.session?.id ?? null
  // Home lists every question, so nothing pops up there.
  const pendingAll = useMemo(() => queueOf(state.questions).pending, [state.questions])

  return (
    <ToastProvider value={toast}>
      <div className="shell">
        <Sidebar
          rows={rows}
          projects={projects}
          hidden={hidden}
          hiddenPending={hiddenPending}
          folders={folders}
          customs={customs}
          choices={choices}
          active={activeKey}
          waiting={wait.total}
          nav={nav}
          onHome={() => open(HOME)}
          onSearch={() => setPalette(true)}
          onOpenRow={openRow}
          onLaunch={launch}
          onAddProject={() => void pickProject()}
          update={(key, change) => void updateSetting(key, change)}
          footer={
            <StatusFooter
              state={state}
              connected={connected === true}
              live={live}
              onToggleLive={toggleLive}
              onReport={() => void ask('report')}
              onOpenUpdate={() => openSettingsAt('settings-update')}
              onSettings={() => open({ kind: 'settings' })}
            />
          }
        />

        <main className={`main ${sessionMode ? 'session-mode' : ''} ${route.kind === 'debug' ? 'browser-mode' : ''}`}>
          <div className="main-notices">
            {connected === true && !live && (
              <Notice tone="warn" bar className="paused-note">
                <span className="small">
                  {t('app.paused')}{' '}
                  <Button variant="link" size="sm" onClick={toggleLive}>
                    {t('app.resumeLive')}
                  </Button>
                </span>
              </Notice>
            )}
            {connected === false && (
              <Notice tone="error" bar title={t('app.disconnected')} className="disconnected">
                <span className="small">{loaded ? t('app.disconnectedStale') : t('app.disconnectedEmpty')}</span>
                {problem && (
                  <span className="small block-line">
                    {t('app.bridgeLast', { line: problem.last || '-' })}{' '}
                    <Button variant="link" size="sm" onClick={() => void window.ide.openBridgeLog()}>
                      {t('app.openBridgeLog')}
                    </Button>
                  </span>
                )}
              </Notice>
            )}
          </div>
          {route.kind === 'debug' && (
            <aside className="browser-side">
              <DebugPanel sessions={state.sessions} settings={state.settings} />
            </aside>
          )}
          {/* The browser stays mounted so its page and comments survive switching screens. */}
          <DebugPage sessions={state.sessions} visible={route.kind === 'debug'} lan={state.settings[BROWSER_LAN_KEY] === true} onShow={() => open({ kind: 'debug' })} />
          {/* Every terminal stays mounted too; the session view shows its own between its header and answers. */}
          <TerminalStage terms={terminals.terms} shown={sessionMode && viewRow?.term ? viewRow.term.id : null} themeKey={String(state.settings.theme ?? '')} />
          {route.kind !== 'debug' && (loaded || connected !== false) && (offline && route.kind === 'home' ? null : renderPage(sessionMode || route.kind !== 'session' ? route : HOME))}
        </main>

        {palette && <Palette items={paletteItems()} onClose={() => setPalette(false)} />}
        {help && <ShortcutHelp keysAnywhere={state.settings[DECISION_KEYS_KEY] === true} onClose={() => setHelp(false)} />}
        {route.kind === 'task' && <PropsPanel tab={route} state={state} node={pickedNode} />}
        <Incoming
          pending={pendingAll}
          ready={loaded}
          watching={watching}
          quiet={route.kind === 'home'}
          where={q => {
            const row = rowOfSession(q.session_id)
            return row ? `${row.title}, ${row.project}` : q.project
          }}
          onOpen={q => openQuestion(q.id)}
        />
        <Toast toasts={toasts} onDismiss={dismiss} />
      </div>
    </ToastProvider>
  )
}

