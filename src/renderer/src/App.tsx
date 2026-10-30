import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeState, CommandKind, GraphNode, Question, Task } from '../../shared/types'
import { Icon, type IconName } from './Icons'
import { Palette, type PaletteItem } from './Palette'
import { PropsPanel } from './PropsPanel'
import { QuestionCard } from './QuestionCard'
import { TaskView } from './TaskView'
import { TopBar } from './TopBar'
import { attentionOf, nextAfter, queueOf, reachOf, tasksByProject, waitingFirst, type Attention } from './model'
import { ArchivePage } from './pages/ArchivePage'
import { DebugPage } from './pages/DebugPage'
import { DebugPanel } from './pages/DebugPanel'
import { GalleryPage } from './pages/GalleryPage'
import { HomePage } from './pages/HomePage'
import { LinearPage } from './pages/LinearPage'
import { LogPage } from './pages/LogPage'
import { SettingsPage } from './pages/SettingsPage'
import { HIDDEN_KEY, hiddenProjects, isRunning, nameForFolder, pickSession, projectFolders, projectsOf, savedProjects, scopeFor, scopeState } from '../../shared/projects'
import { ProjectList } from './ProjectList'
import { Dock } from './Dock'
import { AgentBadge, ApprovalItem, History, NumberBadge, QueueItem, TaskItem, Toast, ToastProvider, useToastList } from './parts'
import { OPEN_CLAUDE_SLOT } from '../../shared/ccr'
import { stalledSessions } from '../../shared/stall'
import { limitedUntil } from '../../shared/limit'
import { CUSTOM_AGENTS_KEY, SHOW_OTHER_AGENTS_KEY, agentTags, customAgents, projectAgents, showOtherAgents } from '../../shared/agents'
import { HOME, activeTab, closeTab, openTab, pruneTabs, railActive, restoreTabs, tabKey, type Tab, type Tabs } from './tabs'
import { applyTheme } from './theme'
import { LOCALE_TAG, resolveLang, setLang, stageLabel, t, type Key } from '../../shared/i18n'

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

const TABS_KEY = 'claude-ide:tabs'
const SCOPE_KEY = 'claude-ide:scope'

type Section = 'home' | 'questions' | 'debug' | 'archive'

const RAIL: { icon: IconName; label: Key | 'Linear'; section?: Section; tab?: Tab; dev?: boolean }[] = [
  { icon: 'home', label: 'rail.home', section: 'home', tab: HOME },
  { icon: 'question', label: 'rail.questions', section: 'questions' },
  { icon: 'debug', label: 'rail.debug', section: 'debug', tab: { kind: 'debug' } },
  { icon: 'archive', label: 'rail.archive', section: 'archive', tab: { kind: 'archive' } },
  { icon: 'history', label: 'rail.history', tab: { kind: 'history' } },
  { icon: 'log', label: 'rail.log', tab: { kind: 'log' } },
  { icon: 'linear', label: 'Linear', tab: { kind: 'linear' } },
  { icon: 'gallery', label: 'rail.gallery', tab: { kind: 'gallery' }, dev: true },
  { icon: 'settings', label: 'rail.settings', tab: { kind: 'settings' } },
]

const TAB_ICON: Partial<Record<Tab['kind'], IconName>> = {
  home: 'home',
  question: 'question',
  debug: 'debug',
  archive: 'archive',
  history: 'history',
  log: 'log',
  linear: 'linear',
  settings: 'settings',
  gallery: 'gallery',
}

// The component gallery is for building the IDE: shown in development or when the settings ask for it.
export function devMenuShown(settings: Record<string, unknown>): boolean {
  return import.meta.env.DEV || settings.devMenu === true
}

// Product names stay as they are in every language.
const railLabel = (label: Key | 'Linear'): string => (label === 'Linear' ? label : t(label))

function loadScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY) || null
  } catch {
    return null
  }
}

function loadTabs(): Tabs {
  try {
    return restoreTabs(JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null'))
  } catch {
    return restoreTabs(null)
  }
}

export function App() {
  const [state, setState] = useState<BridgeState>(EMPTY)
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
  const [tabs, setTabs] = useState<Tabs>(loadTabs)
  const [section, setSection] = useState<Section>('home')
  const [railPick, setRailPick] = useState<IconName | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [palette, setPalette] = useState(false)
  const [scope, setScope] = useState<string | null>(loadScope)
  const { toasts, show: toast, dismiss } = useToastList()
  // Feature area: top bar toggles (dock, live refresh) and the node shown in the properties panel.
  const [dockOpen, setDockOpen] = useState(true)
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

  // The top bar's play button opens a terminal in the dock; a closed dock would hold it out of sight.
  useEffect(() => {
    const open = () => setDockOpen(true)
    window.addEventListener(OPEN_CLAUDE_SLOT, open)
    return () => window.removeEventListener(OPEN_CLAUDE_SLOT, open)
  }, [])

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
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    } catch {
      // per-viewer convenience only
    }
  }, [tabs])

  useEffect(() => {
    try {
      if (scope) localStorage.setItem(SCOPE_KEY, scope)
      else localStorage.removeItem(SCOPE_KEY)
    } catch {
      // per-viewer convenience only
    }
  }, [scope])

  useEffect(() => {
    applyTheme(state.settings.theme)
  }, [state.settings.theme])

  // Tabs of tasks or questions that are gone (archived, cleared) close by themselves.
  useEffect(() => {
    if (!loaded) return
    setTabs(current =>
      pruneTabs(current, tab => {
        if (tab.kind === 'task') return state.tasks.some(t => t.id === tab.id)
        if (tab.kind === 'question') return state.questions.some(q => q.id === tab.id)
        return true
      }),
    )
  }, [loaded, state.tasks, state.questions])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = useCallback((tab: Tab) => setTabs(current => openTab(current, tab)), [])
  // A task or question of another project would open as a hidden tab; the view follows it instead.
  const openTask = (id: number) => {
    setScope(current => scopeFor(current, state.tasks.find(t => t.id === id)?.project))
    open({ kind: 'task', id })
  }
  const openQuestion = (id: number) => {
    setScope(current => scopeFor(current, state.questions.find(q => q.id === id)?.project))
    open({ kind: 'question', id })
  }
  openQuestionRef.current = openQuestion
  // Everything in the sidebar, home, log and dock is seen through the chosen project.
  const view = useMemo(() => scopeState(state, scope), [state, scope])
  const saved = useMemo(() => savedProjects(state.settings.projects), [state.settings.projects])
  // Every project, for names and folders; the switcher leaves out the ones taken off the list.
  const allProjects = useMemo(() => projectsOf(state, saved), [state, saved])
  const hidden = useMemo(() => hiddenProjects(state.settings[HIDDEN_KEY]), [state.settings])
  const projects = useMemo(() => allProjects.filter(p => !hidden.includes(p.name)), [allProjects, hidden])
  const folders = useMemo(() => projectFolders(state.settings.projectFolders), [state.settings])
  // Feature area: agent CLIs other than Claude Code. Badges by session, and the person's own CLIs.
  const customs = useMemo(() => customAgents(state.settings[CUSTOM_AGENTS_KEY]), [state.settings])
  const tags = useMemo(() => agentTags(state.sessions, customs), [state.sessions, customs])
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
  const openQuestionsOf = (task: Task) =>
    state.questions.filter(q => q.status !== 'answered' && q.session_id === task.session_id && q.task_title === task.title).length
  const attentionOfTask = (task: Task): Attention | null =>
    attentionOf({
      openQuestions: openQuestionsOf(task),
      stalled: stalled.has(task.session_id),
      limited: limited.has(task.session_id),
      offline: reachOf(state.sessions.find(s => s.id === task.session_id), state.live ?? []) === 'gone',
      running: isRunning(task),
    })
  const waitingTasks = waitingFirst(view.tasks, attentionOfTask)
  const taskItem = (task: Task, showProject: boolean) => (
    <TaskItem
      key={task.id}
      task={task}
      active={tabs.active === `task:${task.id}`}
      openQuestions={openQuestionsOf(task)}
      nodeCount={state.nodes.filter(n => n.task_id === task.id).length}
      agent={tags[task.session_id]}
      attention={attentionOfTask(task)}
      project={showProject ? task.project : undefined}
      onClick={() => openTask(task.id)}
    />
  )
  const stalledTerms = useMemo(
    () => new Set(state.sessions.filter(s => stalled.has(s.id) && s.terminal).map(s => s.terminal as string)),
    [state.sessions, stalled],
  )
  const { pending, held } = useMemo(() => queueOf(view.questions), [view.questions])
  const pendingApprovals = (state.approvals ?? []).filter(a => a.status === 'pending' && (scope === null || a.project === scope))
  const reachOfQuestion = (q: Question) => reachOf(state.sessions.find(s => s.id === q.session_id), state.live ?? [])
  const inScope = (tab: Tab): boolean => {
    if (scope === null) return true
    if (tab.kind === 'task') return state.tasks.find(t => t.id === tab.id)?.project === scope
    if (tab.kind === 'question') return state.questions.find(q => q.id === tab.id)?.project === scope
    return true
  }
  const shownTabs = tabs.open.filter(inScope)
  const active = inScope(activeTab(tabs)) ? activeTab(tabs) : HOME
  // Reports, syncs and Linear sends go to the newest session of the project in view, or nowhere.
  const latestSession = useMemo(() => pickSession(state.sessions, scope), [state.sessions, scope])
  const showDev = devMenuShown(state.settings)
  const rail = RAIL.filter(r => !r.dev || showDev)
  const railOn = railActive(rail, { picked: railPick, active: tabs.active, section, sidebarOpen })

  // A folder a terminal opened in becomes a project of its own in the switcher.
  const addProject = useCallback(
    async (cwd: string) => {
      // A folder taken off the list comes back when it is added again.
      const name = nameForFolder(allProjects, cwd)
      if (hidden.includes(name)) await window.ide.bridge('POST', '/settings', { key: HIDDEN_KEY, value: hidden.filter(h => h !== name) })
      if (saved.some(p => p.cwd === cwd)) return
      await window.ide.bridge('POST', '/settings', { key: 'projects', value: [...saved, { name, cwd }] })
    },
    [saved, allProjects, hidden],
  )
  const pickProject = async () => {
    const cwd = await window.ide.pickFolder()
    if (!cwd) return
    const name = nameForFolder(allProjects, cwd)
    await addProject(cwd)
    setScope(name)
  }

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

  // After an answer: close that question's tab and open the next one waiting, in this
  // project first; when only another project has one, the view moves there.
  const advance = useCallback(
    async (fromId: number) => {
      const fresh = await window.ide.state()
      if (fresh) setState(fresh)
      const all = fresh?.questions ?? []
      const next = nextAfter(scope === null ? all : all.filter(q => q.project === scope), fromId) ?? nextAfter(all, fromId)
      if (next !== null) setScope(current => scopeFor(current, all.find(q => q.id === next)?.project))
      setTabs(current => {
        const closed = closeTab(current, `question:${fromId}`)
        return next === null ? closed : openTab(closed, { kind: 'question', id: next })
      })
    },
    [scope],
  )

  // Only the project in view; the label counts the same tasks.
  const archiveDone = useCallback(async () => {
    const reply = await window.ide.bridge('POST', '/tasks/archive-done', scope === null ? {} : { project: scope })
    if (!reply.ok) return toast(t('app.archiveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
    toast(t('app.archivedDone', { n: Number(reply.json.count ?? 0) }))
  }, [scope, toast])

  const restore = async (id: number) => {
    const reply = await window.ide.bridge('POST', `/tasks/${id}/restore`)
    toast(reply.ok ? t('app.restored') : t('app.restoreFailed', { error: String(reply.json.error ?? reply.status) }), reply.ok ? 'good' : 'bad')
  }

  const doneCount = view.tasks.filter(t => t.stage === '완료').length
  // Never connected yet: the empty lists say nothing about the data, so they say so.
  const offline = connected === false && !loaded
  const sessionHint = latestSession ? t('app.sessionHint', { id: latestSession.id.slice(0, 8), project: latestSession.project }) : undefined

  const paletteItems: PaletteItem[] = [
    ...state.tasks.map(task => ({ id: `t${task.id}`, group: t('palette.groupTask'), label: task.title, hint: `${task.project}, ${stageLabel(task.stage)}`, run: () => openTask(task.id) })),
    ...state.questions.map(q => ({
      id: `q${q.id}`,
      group: t('palette.groupQuestion'),
      label: `Q${q.id} ${q.question}`,
      hint: t(q.status === 'pending' ? 'palette.qPending' : q.status === 'held' ? 'palette.qHeld' : 'palette.qAnswered'),
      run: () => openQuestion(q.id),
    })),
    ...rail.filter(r => r.tab).map(r => ({ id: `p${r.label}`, group: t('palette.groupScreen'), label: railLabel(r.label), run: () => open(r.tab!) })),
    {
      id: 'a-archive',
      group: t('palette.groupAction'),
      label: t('palette.archiveDone'),
      hint: t('common.count', { n: doneCount }),
      disabled: doneCount === 0 ? t('palette.noDone') : undefined,
      run: () => void archiveDone(),
    },
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

  const tabTitle = (tab: Tab): string => {
    if (tab.kind === 'task') return state.tasks.find(t => t.id === tab.id)?.title ?? t('tab.task')
    if (tab.kind === 'question') return `Q${tab.id}`
    const rail = RAIL.find(r => r.tab && tabKey(r.tab) === tabKey(tab))
    return rail ? railLabel(rail.label) : t('rail.home')
  }

  const logTasks = useMemo(() => [...state.tasks, ...state.archived], [state.tasks, state.archived])

  const renderPage = (tab: Tab) => {
    if (tab.kind === 'home')
      return (
        <HomePage
          state={view}
          badges={tags}
          onOpenTask={openTask}
          onOpenQuestion={openQuestion}
          onPickFolder={() => void pickProject()}
          onAnswerApproval={async (id, decision) => {
            const reply = await window.ide.approve(id, decision)
            if (!reply.ok) toast(t('approval.answerFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
          }}
        />
      )
    if (tab.kind === 'task') {
      const task = state.tasks.find(t => t.id === tab.id)
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
          onQuestion={openQuestion}
          onCommand={(kind, payload) => void command(kind, payload, task.session_id)}
        />
      )
    }
    if (tab.kind === 'question') {
      const q = state.questions.find(one => one.id === tab.id)
      if (!q) return null
      const task = state.tasks.find(t => t.session_id === q.session_id && t.title === q.task_title)
      return (
        <QuestionCard
          key={q.id}
          q={q}
          agent={tags[q.session_id]}
          sessionProject={state.sessions.find(s => s.id === q.session_id)?.project ?? q.project}
          reach={reachOfQuestion(q)}
          peers={state.sessions
            .filter(s => s.id !== q.session_id && (state.live ?? []).includes(s.id))
            .map(s => {
              const task = state.tasks.find(one => one.session_id === s.id && isRunning(one))
              return { id: s.id, name: s.project, label: `${s.project}${s.agent && s.agent !== 'claude' ? ` (${s.agent})` : ''}${task ? `: ${task.title}` : ''}` }
            })}
          onDone={() => void advance(q.id)}
          onOpenTask={task ? () => openTask(task.id) : null}
        />
      )
    }
    if (tab.kind === 'history') return <History questions={view.questions} onOpen={openQuestion} />
    if (tab.kind === 'archive') return <ArchivePage archived={view.archived} onRestore={id => void restore(id)} />
    if (tab.kind === 'log') return <LogPage events={view.events} tasks={logTasks} agents={tags} />
    if (tab.kind === 'linear') return <LinearPage sessions={view.sessions} />
    if (tab.kind === 'settings') return <SettingsPage settings={state.settings} routines={state.routines} runs={state.routineRuns} projects={projects} />
    if (tab.kind === 'gallery') return showDev ? <GalleryPage /> : null
    return null
  }

  return (
    <ToastProvider value={toast}>
      <div className={`shell ${sidebarOpen ? '' : 'sidebar-closed'} ${dockOpen ? '' : 'dock-closed'}`}>
        <TopBar
          state={state}
          scoped={scope ? view : null}
          live={live}
          onToggleLive={() => {
            liveRef.current = !live
            setLive(!live)
            if (!live) void refresh()
          }}
          onToggleSidebar={() => setSidebarOpen(open => !open)}
          onToggleDock={() => setDockOpen(open => !open)}
          connected={connected === true}
          onSearch={() => setPalette(true)}
          onReport={() => void ask('report')}
          onQuestions={() => {
            setRailPick('question')
            setSection('questions')
            setSidebarOpen(true)
          }}
        />

        <nav className="rail">
          {rail.map(item => (
            <button
              key={item.label}
              title={railLabel(item.label)}
              data-rail={item.icon}
              className={`rail-button ${item.icon === railOn ? 'on' : ''}`}
              aria-current={item.icon === railOn ? 'page' : undefined}
              onClick={() => {
                setRailPick(item.icon)
                if (item.section) {
                  setSidebarOpen(item.section === section ? !sidebarOpen : true)
                  setSection(item.section)
                }
                if (item.tab) open(item.tab)
              }}
            >
              <Icon name={item.icon} />
              {item.section === 'questions' && pending.length + pendingApprovals.length > 0 && <span className="rail-badge">{pending.length + pendingApprovals.length}</span>}
            </button>
          ))}
        </nav>

        {sidebarOpen && (
          <aside className="sidebar">
            <button className="sidebar-close" title={t('sidebar.collapse')} onClick={() => setSidebarOpen(false)}>
              <Icon name="collapse" size={14} />
            </button>
            <ProjectList
              projects={projects}
              hidden={hidden}
              folders={folders}
              scope={scope}
              totals={{ running: state.tasks.filter(isRunning).length, pending: state.questions.filter(q => q.status === 'pending').length }}
              badges={name => projectAgents(state.sessions, tags, name).map(tag => <AgentBadge key={tag.kind} tag={tag} />)}
              onScope={setScope}
              onAddProject={() => void pickProject()}
              save={(key, value) => void window.ide.bridge('POST', '/settings', { key, value })}
            />
            {section === 'home' && offline && (
              <section>
                <h2>{t('sidebar.tasks')}</h2>
                <p className="quiet">{t('sidebar.offline')}</p>
              </section>
            )}
            {section === 'home' && !offline && (
              <section>
                <h2>{t('sidebar.tasks')}</h2>
                <div className="sidebar-meta">
                  <span className="quiet small">
                    {t('sidebar.taskCounts', { running: view.tasks.filter(isRunning).length, done: doneCount })}
                  </span>
                  {doneCount > 0 && (
                    <button className="link small" onClick={() => void archiveDone()}>
                      {t('sidebar.archiveDone', { n: doneCount })}
                    </button>
                  )}
                </div>
                {view.tasks.length === 0 && (
                  <p className="quiet" title={t('sidebar.noTasksTitle')}>
                    {t('sidebar.noTasks')}
                  </p>
                )}
                {waitingTasks.waiting.length > 0 && (
                  <div className="project waiting-group">
                    <h3>{t('sidebar.waiting', { n: waitingTasks.waiting.length })}</h3>
                    {waitingTasks.waiting.map(task => taskItem(task, scope === null))}
                  </div>
                )}
                {tasksByProject(waitingTasks.rest).map(([project, list]) => (
                  <div key={project} className="project">
                    <h3>{project}</h3>
                    {list.map(task => taskItem(task, false))}
                  </div>
                ))}
              </section>
            )}
            {section === 'questions' && pendingApprovals.length > 0 && (
              <section className="approvals">
                <h2>
                  {t('approval.title')} <span className="count warn">{pendingApprovals.length}</span>
                </h2>
                {pendingApprovals.map(a => (
                  <ApprovalItem
                    key={a.id}
                    a={a}
                    onAnswer={async decision => {
                      const reply = await window.ide.approve(a.id, decision)
                      if (!reply.ok) toast(t('approval.answerFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
                    }}
                  />
                ))}
              </section>
            )}
            {section === 'questions' && (
              <section>
                <h2>
                  {t('rail.questions')} <span className="count">{pending.length}</span>
                </h2>
                {pending.length === 0 && <p className="quiet">{t('sidebar.noQuestions')}</p>}
                {pending.map(q => (
                  <QueueItem key={q.id} q={q} active={tabs.active === `question:${q.id}`} gone={reachOfQuestion(q) === 'gone'} onClick={() => openQuestion(q.id)} />
                ))}
                <button className="link" onClick={() => open({ kind: 'history' })}>
                  {t('rail.history')} <span className="count">{view.answeredCount}</span>
                </button>
                {held.length > 0 && (
                  <>
                    <h3>{t('sidebar.held', { n: held.length })}</h3>
                    {held.map(q => (
                      <QueueItem key={q.id} q={q} active={tabs.active === `question:${q.id}`} gone={reachOfQuestion(q) === 'gone'} onClick={() => openQuestion(q.id)} />
                    ))}
                  </>
                )}
              </section>
            )}
            {section === 'debug' && <DebugPanel sessions={state.sessions} settings={state.settings} scope={scope} />}
            {section === 'archive' && (
              <section>
                <h2>
                  {t('rail.archive')} <span className="count">{view.archived.length}</span>
                </h2>
                {view.archived.length === 0 && <p className="quiet">{t('sidebar.noArchived')}</p>}
                {view.archived.slice(0, 30).map(task => (
                  <div key={task.id} className="archived-row small">
                    <span className="archived-title">{task.title}</span>
                    <button className="link small" onClick={() => void restore(task.id)}>
                      {t('sidebar.restore')}
                    </button>
                  </div>
                ))}
              </section>
            )}
          </aside>
        )}

        <div className="tabbar">
          {!sidebarOpen && (
            <div className="tabbar-scope">
              <button className="tabbar-expand" title={t('tabbar.expand')} aria-label={t('tabbar.expand')} onClick={() => setSidebarOpen(true)}>
                <Icon name="expand" size={14} />
              </button>
              <button className="chip chip-button scope-chip" title={t('tabbar.changeProject')} onClick={() => setSidebarOpen(true)}>
                {scope ?? t('sidebar.all')}
              </button>
            </div>
          )}
          {shownTabs.map(tab => {
            const key = tabKey(tab)
            const task = tab.kind === 'task' ? state.tasks.find(t => t.id === tab.id) : undefined
            const icon = TAB_ICON[tab.kind]
            return (
              <div
                key={key}
                role="tab"
                tabIndex={0}
                aria-selected={key === tabKey(active)}
                className={`tab ${key === tabKey(active) ? 'on' : ''}`}
                onClick={() => setTabs(current => ({ ...current, active: key }))}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  setTabs(current => ({ ...current, active: key }))
                }}
              >
                {task ? <NumberBadge task={task} /> : icon && <Icon name={icon} size={13} />}
                <span className="tab-title">{tabTitle(tab)}</span>
                {tab.kind !== 'home' && (
                  <button
                    className="tab-close"
                    aria-label={t('tabbar.close', { title: tabTitle(tab) })}
                    title={t('tabbar.close', { title: tabTitle(tab) })}
                    onClick={event => {
                      event.stopPropagation()
                      setTabs(current => closeTab(current, key))
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <main className="main">
          {connected === false && (
            <div className="disconnected" role="alert">
              <b>{t('app.disconnected')}</b>
              <span className="small">
                {loaded ? t('app.disconnectedStale') : t('app.disconnectedEmpty')}
              </span>
              {problem && (
                <span className="small">
                  {t('app.bridgeLast', { line: problem.last || '-' })}{' '}
                  <button className="link small" onClick={() => void window.ide.openBridgeLog()}>
                    {t('app.openBridgeLog')}
                  </button>
                </span>
              )}
            </div>
          )}
          {/* The browser stays mounted so its page and comments survive tab switches. */}
          <DebugPage
            sessions={state.sessions}
            visible={active.kind === 'debug'}
            scope={scope}
            onShow={() => {
              open({ kind: 'debug' })
              setRailPick('debug')
              setSection('debug')
              setSidebarOpen(true)
            }}
          />
          {active.kind !== 'debug' && (loaded || connected !== false) && renderPage(active)}
        </main>

        <Dock
          events={view.events}
          tasks={logTasks}
          scope={scope}
          projects={projects}
          themeKey={String(state.settings.theme ?? '')}
          logShown={active.kind === 'log'}
          emptyLog={offline ? t('app.offlineLog') : undefined}
          onExpandLog={() => open({ kind: 'log' })}
          onFolder={cwd => void addProject(cwd)}
          agents={tags}
          stalledTerms={stalledTerms}
          customs={customs}
          showOthers={showOtherAgents(state.settings[SHOW_OTHER_AGENTS_KEY])}
        />

        {palette && <Palette items={paletteItems} onClose={() => setPalette(false)} />}
        <PropsPanel tab={active} state={state} node={pickedNode} />
        <Toast toasts={toasts} onDismiss={dismiss} />
      </div>
    </ToastProvider>
  )
}
