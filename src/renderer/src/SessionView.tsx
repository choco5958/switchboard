import { useEffect, useState } from 'react'
import type { Approval, BridgeState, GraphNode, Question, Session } from '../../shared/types'
import type { AgentTag, CustomAgent } from '../../shared/agents'
import { t } from '../../shared/i18n'
import { QuestionCard } from './QuestionCard'
import { ApprovalItem, LogLines, ResumeButton } from './parts'
import type { Reach } from './model'
import { rowAgent, rowStateText } from './Sidebar'
import { needsAnswer, type SessionRow } from './sessions'
import { Button, EmptyState, cx } from './ui'

const CLOSE_ARMED_MS = 3000

// What waits elsewhere once this session has nothing left to answer: the next thing in line.
export type NextUp = { count: number; kind: 'question' | 'approval'; title: string; where: string; go: () => void }

// One session in the main area: its header, its terminal (App places TerminalStage between the
// header and the answer area, so terminals stay mounted while the view changes), or for a session
// outside the app its latest log lines, and under it whatever it asks the person.
export function SessionView({
  row,
  customs,
  nodes,
  events,
  tasks,
  agents,
  reach,
  resume,
  peers,
  next,
  keysAnywhere,
  onOpenTask,
  onCloseTerm,
  onAnswerApproval,
}: {
  row: SessionRow
  customs: CustomAgent[]
  nodes: GraphNode[] // the nodes of the row's task
  events: BridgeState['events']
  tasks: BridgeState['tasks']
  agents: Record<string, AgentTag>
  reach: Reach
  resume?: Session // the gone session, when the app can open it again (model.ts resumable)
  peers: { id: string; name: string; label: string }[]
  next: NextUp | null
  keysAnywhere: boolean
  onOpenTask: (id: number) => void
  onCloseTerm: (id: string) => void
  onAnswerApproval: (a: Approval, decision: 'allow' | 'deny' | 'terminal', note?: string) => void
}) {
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(false), CLOSE_ARMED_MS)
    return () => clearTimeout(timer)
  }, [closing])
  useEffect(() => setClosing(false), [row.key])

  const done = nodes.filter(n => n.status === '끝').length
  const question: Question | undefined = row.questions[0]
  const own = row.session ? events.filter(e => e.session_id === row.session!.id).slice(-80) : []
  const where = row.cwd.replace(/^\/Users\/[^/]+/, '~')

  return (
    <>
      <header className="session-head">
        <span className={cx('state-dot', 'head-dot')} data-state={row.state} aria-hidden="true" />
        <h1 className="session-name">{row.title}</h1>
        {rowAgent(row, customs) && <span className="quiet">{rowAgent(row, customs)}</span>}
        <span className="quiet small mono-inline session-where" title={row.cwd}>
          {where}
        </span>
        {rowStateText(row) && <span className={cx('session-state', needsAnswer(row.state) && 'strong')} data-state={row.state}>{rowStateText(row)}</span>}
        <span className="spacer" />
        {nodes.length > 0 && <span className="quiet small">{t('session.progress', { done, total: nodes.length })}</span>}
        {row.task && (
          <Button size="sm" onClick={() => onOpenTask(row.task!.id)}>
            {t('session.openTask')}
          </Button>
        )}
        {resume && <ResumeButton session={resume} />}
        {row.term && (
          <Button
            size="sm"
            variant="ghost"
            className={cx(closing && 'armed')}
            title={row.term.alive ? t('dock.closeArmedTitle') : undefined}
            onClick={() => {
              if (row.term!.alive && !closing) return setClosing(true)
              onCloseTerm(row.term!.id)
            }}
          >
            {closing ? t('dock.closeConfirm') : t('session.closeTerm')}
          </Button>
        )}
      </header>

      {!row.term && (
        <section className="session-outside" aria-label={t('session.outsideLog')}>
          <p className="quiet small">{t(row.state === 'offline' || row.state === 'ended' ? 'session.gone' : 'session.outside')}</p>
          <div className="worklog-body">
            <LogLines events={own} tasks={tasks} agents={agents} empty={t('session.noLog')} />
          </div>
        </section>
      )}

      <section className={cx('session-answer', !question && row.approvals.length === 0 && !next && 'empty')} aria-label={t('session.answerArea')}>
        {question && (
          <>
            {row.questions.length > 1 && <p className="quiet small session-more">{t('session.moreQuestions', { n: row.questions.length })}</p>}
            <QuestionCard
              key={question.id}
              q={question}
              docked
              agent={row.session ? agents[row.session.id] : undefined}
              sessionProject={row.project}
              reach={reach}
              resume={resume}
              peers={peers}
              onDone={() => undefined}
              onOpenTask={row.task ? () => onOpenTask(row.task!.id) : null}
              keysAnywhere={keysAnywhere}
            />
          </>
        )}
        {!question &&
          row.approvals.map(a => <ApprovalItem key={a.id} a={a} onAnswer={(decision, note) => onAnswerApproval(a, decision, note)} />)}
        {!question && row.approvals.length === 0 && next && (
          <div className="next-up">
            <span className="next-count">{t('session.nextCount', { n: next.count })}</span>
            <span className="next-kind">{t(next.kind === 'question' ? 'row.question' : 'row.approval')}</span>
            <span className="quiet">{next.where}</span>
            <span className="next-title">{next.title}</span>
            <span className="spacer" />
            <Button variant="primary" size="sm" onClick={next.go}>
              {t('session.next')}
            </Button>
          </div>
        )}
        {!question && row.approvals.length === 0 && !next && !row.term && own.length === 0 && <EmptyState className="small">{t('session.nothing')}</EmptyState>}
      </section>
    </>
  )
}
