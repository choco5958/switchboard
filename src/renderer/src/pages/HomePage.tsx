import { useMemo } from 'react'
import type { BridgeState, GraphNode } from '../../../shared/types'
import { taskStateLabel, isRunning, taskState } from '../../../shared/projects'
import { stageLabel, t } from '../../../shared/i18n'
import { tx } from '../tx'
import { STAGES, ago } from '../model'
import { AgentBadge, ApprovalItem, NumberBadge } from '../parts'
import { Button, VisuallyHidden, cx, surfaceClass } from '../ui'
import type { AgentTag } from '../../../shared/agents'

// What a first start looks like: no tasks yet, so instead of four zeros, how to get going.
function FirstRun({ sessions, onPickFolder }: { sessions: number; onPickFolder: () => void }) {
  return (
    <div className="card first-run">
      <h1>{t('home.start')}</h1>
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
      </ol>
    </div>
  )
}

export function HomePage({
  state,
  badges = {},
  onOpenTask,
  onOpenQuestion,
  onPickFolder,
  onAnswerApproval,
}: {
  state: BridgeState
  badges?: Record<string, AgentTag> // session id to its agent badge
  onOpenTask: (id: number) => void
  onOpenQuestion: (id: number) => void
  onPickFolder: () => void
  onAnswerApproval: (id: number, decision: 'allow' | 'deny' | 'terminal') => void
}) {
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
  const pending = state.questions.filter(q => q.status === 'pending')
  const agents = state.agents.filter(a => a.status === 'running')
  // Permission asks wait here too: one is not "nothing to do yet".
  const approvals = (state.approvals ?? []).filter(a => a.status === 'pending')
  const asks =
    approvals.length > 0 ? (
      <section className="approvals home-approvals">
        <h3>
          {t('approval.title')} <span className="count warn">{approvals.length}</span>
        </h3>
        {approvals.map(a => (
          <ApprovalItem key={a.id} a={a} onAnswer={decision => onAnswerApproval(a.id, decision)} />
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
  return (
    <div className="home">
      <div className="home-stats">
        <div className={surfaceClass({}, 'stat')}><b>{running.length}</b><span>{t('home.statRunning')}</span></div>
        <div className={surfaceClass({}, 'stat')}><b>{pending.length}</b><span>{t('rail.questions')}</span></div>
        <div className={surfaceClass({}, 'stat')}><b>{agents.length}</b><span>{t('home.statAgents')}</span></div>
        <div className={surfaceClass({}, 'stat')}><b>{state.answeredCount}</b><span>{t('home.statAnswered')}</span></div>
      </div>
      {asks}
      <div className="home-grid">
        {state.tasks.map(task => {
          const nodes = nodesOf.get(task.id) ?? []
          const done = nodes.filter(n => n.status === '끝').length
          const status = taskState(task)
          const at = STAGES.indexOf(task.stage)
          return (
            <button key={task.id} type="button" className={surfaceClass({}, 'home-card')} onClick={() => onOpenTask(task.id)}>
              <div className="task-title"><NumberBadge task={task} /> {task.title} <AgentBadge tag={badges[task.session_id]} /></div>
              <div className="quiet small">
                <span className={`status status-${status}`}>{taskStateLabel(status)}</span>, {task.project}, {stageLabel(task.stage)}, {t('home.nodes', { done, total: nodes.length })}, {ago(task.updated_at)}
              </div>
              {task.now && <div className="small">{t('task.now', { now: task.now })}</div>}
              {/* Done stages are solid, the current one striped, the ones ahead only outlined; the words are for screen readers. */}
              <div className="mini-stages" aria-hidden="true">
                {STAGES.map((s, i) => (
                  <span key={s} className={cx(i < at && 'done', i === at && 'now')} />
                ))}
              </div>
              <VisuallyHidden>{t('home.stagesDone', { done: Math.max(0, at), total: STAGES.length })}</VisuallyHidden>
            </button>
          )
        })}
      </div>
      {pending.length > 0 && (
        <>
          <h3>{t('home.pendingQuestions')}</h3>
          {pending.map(q => (
            <Button key={q.id} variant="link" className="block" onClick={() => onOpenQuestion(q.id)}>
              <span className="qid">Q{q.id}</span> [{q.task_title || q.project}] {q.question}
            </Button>
          ))}
        </>
      )}
    </div>
  )
}
