import { useSyncExternalStore } from 'react'
import type { Approval, BridgeState, Question, Session } from '../../../shared/types'
import { agentLabel, type CustomAgent } from '../../../shared/agents'
import { t } from '../../../shared/i18n'
import { tx } from '../tx'
import { ago, optionsOf, queueOf } from '../model'
import { sendAnswer } from '../answer'
import { isWaiting, subscribe, takeBack } from '../outbox'
import { ApprovalItem, ResumeButton, useToast } from '../parts'
import { rowStateText } from '../Sidebar'
import { needsLook, type SessionRow } from '../sessions'
import { Badge, Button, EmptyState, cx } from '../ui'
import { ClaudeMissingNotice, ConnectStep } from '../flows'

// What a first start looks like: no sessions yet, so instead of empty lists, how to get going.
function FirstRun({ sessions, onPickFolder }: { sessions: number; onPickFolder: () => void }) {
  return (
    <div className="card first-run">
      <h1>{t('home.start')}</h1>
      <ClaudeMissingNotice />
      <ol className="first-run-steps">
        <li>
          <b>{t('home.step1')}</b>
          <p className="quiet">{tx('home.step1Body', { folder: <span className="kbd-like">{t('sidebar.addFolder')}</span> })}</p>
          <Button variant="link" size="sm" className="inline-link" onClick={onPickFolder}>
            {t('home.pickNow')}
          </Button>
        </li>
        <li>
          <b>{t('home.step2')}</b>
          <p className="quiet">
            {tx('home.step2Body', { claude: <span className="kbd-like">+</span> })}
            {sessions > 0 && ` ${t('home.sessionsNow', { n: sessions })}`}
          </p>
        </li>
        <li>
          <b>{t('home.step3')}</b>
          <p className="quiet">{t('home.step3Body')}</p>
        </li>
        <ConnectStep />
      </ol>
    </div>
  )
}

// One question, answered with a press on its option: the answer waits a few seconds for Undo
// (answer.ts), and anything more (a note, holding, handing it on) is in its session.
function QuickQuestion({ q, row, onOpen }: { q: Question; row?: SessionRow; onOpen: () => void }) {
  const toast = useToast()
  const sending = useSyncExternalStore(subscribe, () => isWaiting(q.id))
  const options = optionsOf(q)
  return (
    <article className={cx('card home-ask', sending && 'sending')} aria-label={`Q${q.id} ${q.question}`}>
      <div className="home-ask-meta small">
        <span className="ask-kind warn">{t('row.question')}</span>
        {q.task_title && <span>{q.task_title}</span>}
        <span className="quiet">{row ? `${row.project}, ${agentLabel(row.agent)}` : q.project}</span>
        <span className="spacer" />
        <span className="quiet">{ago(q.created_at)}</span>
      </div>
      <h3 className="home-ask-title">{q.question}</h3>
      {q.reason && <p className="quiet small home-ask-reason">{q.reason}</p>}
      <div className="home-ask-actions">
        {sending ? (
          <>
            <span className="quiet small">{t('question.queued')}</span>
            <Button size="sm" onClick={() => takeBack(q.id)}>
              {t('common.undo')}
            </Button>
          </>
        ) : (
          options.map(o => (
            <Button key={o.key} size="sm" className={cx('quick-option', o.key === q.recommend && 'recommended')} title={o.label} onClick={() => sendAnswer(q.id, o.key, '', toast)}>
              <span className="mono-inline quick-key">{o.key}</span>
              <span className="quick-label">{o.label}</span>
              {o.key === q.recommend && (
                <Badge tone="good" fill="solid">
                  {t('question.recommended')}
                </Badge>
              )}
            </Button>
          ))
        )}
        <span className="spacer" />
        <Button variant="link" size="sm" onClick={onOpen}>
          {t('home.openSession')}
        </Button>
      </div>
    </article>
  )
}

export function HomePage({
  state,
  rows,
  customs,
  resumeOf,
  onOpenRow,
  onOpenQuestion,
  onPickFolder,
  onAnswerApproval,
}: {
  state: BridgeState
  rows: SessionRow[]
  customs: CustomAgent[]
  resumeOf: (sessionId: string) => Session | undefined
  onOpenRow: (row: SessionRow) => void
  onOpenQuestion: (id: number) => void
  onPickFolder: () => void
  onAnswerApproval: (a: Approval, decision: 'allow' | 'deny' | 'terminal', note?: string) => void
}) {
  const rowOf = (sessionId: string) => rows.find(r => r.session?.id === sessionId)
  const pending = queueOf(state.questions).pending
  const approvals = (state.approvals ?? []).filter(a => a.status === 'pending')
  const look = rows.filter(r => needsLook(r.state))
  const working = rows.filter(r => r.state === 'working')
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  const done = state.tasks.filter(task => task.stage === '완료' && task.updated_at > dayAgo)
  const answers = pending.length + approvals.length

  if (rows.length === 0 && state.tasks.length === 0 && answers === 0) {
    return (
      <div className="home home-empty">
        <FirstRun sessions={state.sessions.length} onPickFolder={onPickFolder} />
      </div>
    )
  }
  const open = (sessionId: string, questionId?: number) => {
    const row = rowOf(sessionId)
    if (row) onOpenRow(row)
    else if (questionId !== undefined) onOpenQuestion(questionId)
  }

  return (
    <div className="home">
      <header className="home-head">
        <h1>{t('rail.home')}</h1>
        <span className="quiet">{t('home.summary', { sessions: rows.filter(r => r.state !== 'ended').length, answers })}</span>
      </header>

      <section className="home-section" aria-labelledby="home-answers">
        <h2 id="home-answers" className="home-heading warn">
          {t('home.toAnswer', { n: answers })}
        </h2>
        {answers === 0 && <EmptyState className="small">{t('home.nothingToAnswer')}</EmptyState>}
        <div className="home-asks">
          {pending.map(q => (
            <QuickQuestion key={q.id} q={q} row={rowOf(q.session_id)} onOpen={() => open(q.session_id, q.id)} />
          ))}
          {approvals.map(a => (
            <ApprovalItem key={a.id} a={a} onAnswer={(decision, note) => onAnswerApproval(a, decision, note)} />
          ))}
        </div>
      </section>

      {look.length > 0 && (
        <section className="home-section" aria-labelledby="home-look">
          <h2 id="home-look" className="home-heading bad">
            {t('home.toLook', { n: look.length })}
          </h2>
          {look.map(row => {
            const resume = row.session ? resumeOf(row.session.id) : undefined
            return (
              <div key={row.key} className="home-line" data-state={row.state}>
                <span className="state-dot" aria-hidden="true" />
                <span className="home-line-text">
                  <b>{row.title}</b>
                  <span className="quiet small">
                    {row.project}, {agentLabel(row.agent, customs)}, {rowStateText(row)}
                  </span>
                </span>
                <span className="spacer" />
                {resume && <ResumeButton session={resume} />}
                <Button size="sm" onClick={() => onOpenRow(row)}>
                  {t('home.openSession')}
                </Button>
              </div>
            )
          })}
        </section>
      )}

      <section className="home-section" aria-labelledby="home-working">
        <h2 id="home-working" className="home-heading">
          {t('home.working', { n: working.length, done: done.length })}
        </h2>
        {working.map(row => (
          <button key={row.key} type="button" className="home-line interactive" data-state={row.state} onClick={() => onOpenRow(row)}>
            <span className="state-dot" aria-hidden="true" />
            <span className="home-line-text">
              <b>{row.title}</b>
              <span className="quiet small">
                {row.project}, {agentLabel(row.agent, customs)}
                {row.task?.now ? `, ${row.task.now}` : ''}
              </span>
            </span>
          </button>
        ))}
        {done.map(task => (
          <div key={task.id} className="home-line" data-state="ended">
            <span className="state-dot" aria-hidden="true" />
            <span className="home-line-text">
              <b className="quiet">{task.title}</b>
              <span className="quiet small">
                {task.project}, {t('home.doneAt', { ago: ago(task.updated_at) })}
                {task.artifact ? `, ${task.artifact}` : ''}
              </span>
            </span>
          </div>
        ))}
        {working.length === 0 && done.length === 0 && <EmptyState className="small">{t('home.nothingRunning')}</EmptyState>}
      </section>
    </div>
  )
}
