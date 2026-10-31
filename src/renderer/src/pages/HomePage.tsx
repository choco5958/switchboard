import { useMemo, useRef, useState } from 'react'
import type { BridgeState, GraphNode, Task } from '../../../shared/types'
import { taskStateLabel, isRunning, taskState, type TaskState } from '../../../shared/projects'
import { stageLabel, t } from '../../../shared/i18n'
import { tx } from '../tx'
import { STAGES, ago, optionsOf, queueOf } from '../model'
import { AgentBadge, ApprovalItem, NumberBadge } from '../parts'
import { Badge, Button, EmptyState, VisuallyHidden, cx, surfaceClass, type Tone } from '../ui'
import type { AgentTag } from '../../../shared/agents'
import { ClaudeMissingNotice, ConnectStep } from '../flows'

// What a first start looks like: no tasks yet, so instead of four zeros, how to get going.
function FirstRun({ sessions, onPickFolder }: { sessions: number; onPickFolder: () => void }) {
  return (
    <div className="card first-run">
      <h1>{t('home.start')}</h1>
      <ClaudeMissingNotice />
      <ol className="first-run-steps">
        <li>
          <b>{t('home.step1')}</b>
          <p className="quiet">
            {tx('home.step1Body', { folder: <span className="kbd-like">{t('sidebar.addFolder')}</span> })}
          </p>
          <Button variant="link" size="sm" className="inline-link" onClick={onPickFolder}>
            {t('home.pickNow')}
          </Button>
        </li>
        <li>
          <b>{t('home.step2')}</b>
          <p className="quiet">
            {tx('home.step2Body', { claude: <span className="kbd-like">+ Claude</span> })}
            {sessions > 0 && ` ${t('home.sessionsNow', { n: sessions })}`}
          </p>
        </li>
        <li>
          <b>{t('home.step3')}</b>
          <p className="quiet">
            {t('home.step3Body')}
          </p>
        </li>
        <ConnectStep />
      </ol>
    </div>
  )
}

// The tone of a task's state chip: what runs in the accent, what is done in green.
const STATE_TONE: Record<TaskState, Tone> = { run: 'accent', wait: 'neutral', done: 'good' }

// Which task cards show: all, the active ones, or those with subagents at work.
type Filter = 'running' | 'agents' | null

export function HomePage({
  state,
  badges = {},
  onOpenTask,
  onOpenQuestion,
  onOpenQueue,
  onOpenHistory,
  onPickFolder,
  onAnswerApproval,
}: {
  state: BridgeState
  badges?: Record<string, AgentTag> // session id to its agent badge
  onOpenTask: (id: number) => void
  onOpenQuestion: (id: number) => void
  onOpenQueue: () => void // the decision queue in the sidebar, with the oldest question open
  onOpenHistory: () => void
  onPickFolder: () => void
  onAnswerApproval: (id: number, decision: 'allow' | 'deny' | 'terminal', note?: string) => void
}) {
  const [filter, setFilter] = useState<Filter>(null)
  const grid = useRef<HTMLElement>(null)
  // Each card's nodes, grouped once per state rather than filtered once per card.
  const nodesOf = useMemo(() => {
    const byTask = new Map<number, GraphNode[]>()
    for (const n of state.nodes) {
      const list = byTask.get(n.task_id)
      if (list) list.push(n)
      else byTask.set(n.task_id, [n])
    }
    return byTask
  }, [state.nodes])
  const running = state.tasks.filter(isRunning)
  // Oldest first: they have waited longest.
  const pending = queueOf(state.questions).pending
  const agents = state.agents.filter(a => a.status === 'running')
  // A subagent belongs to the task of its session with the same title, as the task view counts them.
  const agentsOf = (task: Task) => agents.filter(a => a.session_id === task.session_id && a.task_title === task.title).length
  // Permission asks wait here too: one is not "nothing to do yet".
  const approvals = (state.approvals ?? []).filter(a => a.status === 'pending')
  const asks =
    approvals.length > 0 ? (
      <section className="approvals home-approvals">
        <h3>
          {t('approval.title')} <span className="count warn">{approvals.length}</span>
        </h3>
        {approvals.map(a => (
          <ApprovalItem key={a.id} a={a} onAnswer={(decision, note) => onAnswerApproval(a.id, decision, note)} />
        ))}
      </section>
    ) : null
  if (state.tasks.length === 0 && pending.length === 0) {
    return (
      <div className="home home-empty">
        {asks}
        <FirstRun sessions={state.sessions.length} onPickFolder={onPickFolder} />
      </div>
    )
  }
  const shown = filter === 'running' ? running : filter === 'agents' ? state.tasks.filter(task => agentsOf(task) > 0) : state.tasks
  // A tile that filters toggles; the cards it filters come into view.
  const pick = (next: Filter) => {
    setFilter(current => (current === next ? null : next))
    grid.current?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div className="home">
      {/* What waits for the person comes first: the decisions, then the permission asks. */}
      {pending.length > 0 && (
        <section className="home-section" aria-labelledby="home-questions">
          <h2 id="home-questions" className="home-heading">
            {t('home.pendingQuestions')}{' '}
            <Badge shape="count" tone="warn">
              {pending.length}
            </Badge>
          </h2>
          <div className="home-questions">
            {pending.map(q => {
              const recommended = optionsOf(q).find(o => o.key === q.recommend)
              return (
                <button key={q.id} type="button" className={surfaceClass({ interactive: true, tone: 'warn' }, 'home-question')} onClick={() => onOpenQuestion(q.id)}>
                  <span className="home-question-head">
                    <span className="qid">Q{q.id}</span>
                    <span className="tag">{q.task_title || q.project}</span>
                    <AgentBadge tag={badges[q.session_id]} />
                    <span className="quiet small home-age">{ago(q.created_at)}</span>
                  </span>
                  <span className="home-question-text">{q.question}</span>
                  {recommended && (
                    <span className="home-question-rec small">
                      <Badge tone="good">{t('question.recommended')}</Badge>
                      <span>
                        ({recommended.key}) {recommended.label}
                      </span>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      )}
      {asks}
      <div className="home-stats">
        <button
          type="button"
          className={surfaceClass({ interactive: true, on: filter === 'running' }, 'stat')}
          aria-pressed={filter === 'running'}
          title={t('home.filterRunning')}
          onClick={() => pick('running')}
        >
          <b>{running.length}</b>
          <span>{t('home.statRunning')}</span>
        </button>
        <button type="button" className={surfaceClass({ interactive: true }, 'stat')} title={t('home.openQueue')} onClick={onOpenQueue}>
          <b>{pending.length}</b>
          <span>{t('rail.questions')}</span>
        </button>
        <button
          type="button"
          className={surfaceClass({ interactive: true, on: filter === 'agents' }, 'stat')}
          aria-pressed={filter === 'agents'}
          title={t('home.filterAgents')}
          onClick={() => pick('agents')}
        >
          <b>{agents.length}</b>
          <span>{t('home.statAgents')}</span>
        </button>
        <button type="button" className={surfaceClass({ interactive: true }, 'stat')} title={t('home.openHistory')} onClick={onOpenHistory}>
          <b>{state.answeredCount}</b>
          <span>{t('home.statAnswered')}</span>
        </button>
      </div>
      <section ref={grid} className="home-section" aria-labelledby="home-tasks">
        <div className="home-heading-row">
          <h2 id="home-tasks" className="home-heading">
            {t('home.tasksTitle')}
          </h2>
          {filter && (
            <span className="quiet small" role="status">
              {t(filter === 'running' ? 'home.filteredRunning' : 'home.filteredAgents')}{' '}
              <Button variant="link" size="sm" className="inline-link" onClick={() => setFilter(null)}>
                {t('home.showAll')}
              </Button>
            </span>
          )}
        </div>
        {shown.length === 0 && <EmptyState>{t('home.noneFiltered')}</EmptyState>}
        <div className="home-grid">
          {shown.map(task => {
            const nodes = nodesOf.get(task.id) ?? []
            const done = nodes.filter(n => n.status === '끝').length
            const status = taskState(task)
            const at = STAGES.indexOf(task.stage)
            const working = agentsOf(task)
            return (
              <button key={task.id} type="button" className={surfaceClass({ interactive: true }, 'home-card')} onClick={() => onOpenTask(task.id)}>
                <span className="task-title">
                  <NumberBadge task={task} /> {task.title} <AgentBadge tag={badges[task.session_id]} />
                </span>
                {/* Small parts instead of one comma line; a task without a plan has no node count. */}
                <span className="home-card-meta">
                  <Badge shape="pill" tone={STATE_TONE[status]}>
                    {taskStateLabel(status)}
                  </Badge>
                  <Badge>{task.project}</Badge>
                  {/* A done task's stage is 완료, which its state chip already says. */}
                  {status !== 'done' && <Badge>{stageLabel(task.stage)}</Badge>}
                  {nodes.length > 0 && <Badge>{t('home.nodes', { done, total: nodes.length })}</Badge>}
                  {working > 0 && <Badge tone="accent">{t('home.agentsOnCard', { n: working })}</Badge>}
                  <span className="quiet small home-age">{ago(task.updated_at)}</span>
                </span>
                {task.now && <span className="small home-card-now">{t('task.now', { now: task.now })}</span>}
                {/* Done stages are solid, the current one striped, the ones ahead only outlined; the words are for screen readers. */}
                <span className="mini-stages" aria-hidden="true">
                  {STAGES.map((s, i) => (
                    <span key={s} className={cx(i < at && 'done', i === at && 'now')} />
                  ))}
                </span>
                <VisuallyHidden>{t('home.stagesDone', { done: Math.max(0, at), total: STAGES.length })}</VisuallyHidden>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
