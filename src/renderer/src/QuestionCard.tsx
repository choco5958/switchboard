import { useEffect, useRef, useState } from 'react'
import type { Question } from '../../shared/types'
import { renderMarkdown } from './markdown'
import { clock, keyAction, optionsOf, type Reach } from './model'
import { AgentBadge } from './parts'
import type { AgentTag } from '../../shared/agents'
import { t } from '../../shared/i18n'
import { tx } from './tx'
import { composing } from './ime'
import { Icon } from './Icons'
import { Badge, Button, Notice, Select, TextArea, surfaceClass } from './ui'

const HOLD_AGAIN_MS = 2000

// Settings: the single-letter keys (a, b, 1, 2, Enter, H, M) answer from anywhere in the window,
// not only while the decision card holds focus.
export const DECISION_KEYS_KEY = 'decisionKeysAnywhere'

export function QuestionCard({
  q,
  agent,
  sessionProject,
  reach = 'unknown',
  peers = [],
  onDone,
  onOpenTask,
  keysAnywhere = false,
}: {
  q: Question
  agent?: AgentTag // the agent CLI that asked, once other agents than Claude are around
  sessionProject: string
  reach?: Reach // whether the session can take the answer now
  peers?: { id: string; name: string; label: string }[] // connected sessions other than the asker, to hand the question to
  onDone: () => void
  onOpenTask: (() => void) | null
  keysAnywhere?: boolean // settings: DECISION_KEYS_KEY
}) {
  const options = optionsOf(q)
  const [choice, setChoice] = useState<string>('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState('')
  // The h key holds only when pressed twice: one stray h (typed where the person thought a
  // terminal had focus) only says what the next one would do.
  const [holdArmed, setHoldArmed] = useState(0)
  const [busy, setBusy] = useState(false)
  const memoBox = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const isOpen = q.status !== 'answered'
  const [forwardTo, setForwardTo] = useState('')
  const forwardedTo = q.forwarded_to ? (peers.find(p => p.id === q.forwarded_to)?.name ?? q.forwarded_to) : ''
  const chosen = options.find(o => o.key === q.choice)

  const submit = async (picked: string, note: string) => {
    if (!picked && !note.trim()) return setError(t('question.needChoice'))
    setBusy(true)
    const reply = await window.ide.answer(q.id, picked, note)
    setBusy(false)
    if (!reply.ok) return setError(String(reply.json.error ?? t('question.sendFailed')))
    onDone()
  }

  // Another session answers in the person's place; its reply becomes this question's answer.
  const forward = async () => {
    if (!forwardTo) return
    setBusy(true)
    const reply = await window.ide.forward(q.id, forwardTo)
    setBusy(false)
    if (!reply.ok) return setError(String(reply.json.error ?? t('question.forwardFailed')))
    setForwardTo('')
  }

  // The hint goes once its two seconds are over.
  useEffect(() => {
    if (!holdArmed) return
    const timer = setTimeout(() => setHoldArmed(0), HOLD_AGAIN_MS)
    return () => clearTimeout(timer)
  }, [holdArmed])

  const hold = async () => {
    const reply = await window.ide.hold(q.id)
    if (!reply.ok) return setError(String(reply.json.error ?? t('question.holdFailed')))
    onDone()
  }

  // The card takes focus when it opens, so the next question is answerable without clicking it
  // first. Its single-letter keys work while focus is in the card (a click anywhere on it puts it
  // there), not while typing in a field; a key typed into the terminal or another pane stays
  // there (WCAG 2.1.4). The setting lets them work from anywhere in the window, as before.
  useEffect(() => {
    if (!card.current?.contains(document.activeElement)) card.current?.focus({ preventScroll: true })
  }, [q.id])
  const onKey = useRef<(event: KeyboardEvent) => void>(() => undefined)
  onKey.current = event => {
    const target = event.target as HTMLElement | null
    if (!keysAnywhere && !(target && card.current?.contains(target))) return
    const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.tagName === 'SELECT'
    // Enter or Space on a focused button, link, tab or menu entry presses that control, not Send.
    // The card's own option buttons are the exception: pick one with the mouse, then Enter sends it.
    const control = target?.closest?.('button, a[href], [role="tab"], [role="menuitem"], [role="button"]')
    const pressing = (event.key === 'Enter' || event.key === ' ') && !!control && !control.classList.contains('option')
    if (event.defaultPrevented || pressing) return
    if (!isOpen || busy || typing || composing(event) || event.metaKey || event.ctrlKey || event.altKey) return
    const action = keyAction(event.key, options)
    if (action.type === 'none') return
    event.preventDefault()
    if (action.type === 'choose') setChoice(action.key)
    if (action.type === 'send') void submit(choice, memo)
    if (action.type === 'hold') {
      if (Date.now() - holdArmed < HOLD_AGAIN_MS) {
        setHoldArmed(0)
        void hold()
      } else setHoldArmed(Date.now())
    }
    if (action.type === 'memo') memoBox.current?.focus()
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const onMemoKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !composing(event)) {
      event.preventDefault()
      void submit(choice, memo)
    }
    if (event.key === 'Escape') memoBox.current?.blur()
  }

  return (
    <div className="card decision-card" ref={card} tabIndex={-1} aria-label={`Q${q.id} ${q.question}`}>
      <div className="card-head">
        <span className="qid">Q{q.id}</span>
        <span className="tag">[{q.task_title || q.project}]</span>
        <span className="spacer" />
        {reach === 'gone' && (isOpen || !q.delivered) && (
          <Badge shape="pill" title={t('question.goneTitle')}>
            {t('question.gone')}
          </Badge>
        )}
        <Badge shape="pill" tone={q.status === 'pending' ? 'warn' : q.status === 'held' ? 'neutral' : 'good'}>
          {t(q.status === 'pending' ? 'palette.qPending' : q.status === 'held' ? 'palette.qHeld' : 'palette.qAnswered')}
        </Badge>
      </div>
      <h1>{q.question}</h1>
      {q.task_title && <p className="quiet small">{t('question.task', { task: q.task_title })}</p>}
      {/* renderMarkdown escapes every character of the body before adding its own few tags. */}
      {q.body && <div className="body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.body) }} />}

      {options.length > 0 && (
        <>
          <h3 className="q-section">{t('question.options')}</h3>
          <ul className="q-list">
            {options.map(o => (
              <li key={o.key}>
                ({o.key}) {o.label}{' '}
                {q.recommend === o.key && (
                  <Badge tone="good" fill="solid" className="recommend">
                    {t('question.recommended')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {q.reason && (
        <p className="md-rec">
          <Icon name="expand" size="sm" />
          <span>
            ({q.recommend}). {q.reason}
          </span>
        </p>
      )}

      {/* Only once answered: before that the options below are where the answer goes. */}
      {!isOpen && (
        <>
          <h3 className="q-section">{t('history.colAnswer')}</h3>
          <ul className="q-list answered">
            <li>{t('question.picked', { value: q.choice ? `(${q.choice}) ${chosen?.label ?? ''}` : t('question.memoOnly') })}</li>
            <li>
              {t('question.how', { value: q.memo || t('question.noMemo') })}{' '}
              {q.delivered ? t('question.delivered') : reach === 'gone' ? t('question.notDeliveredGone') : t('question.notDelivered')}
            </li>
            <li>{t('question.answeredAt', { time: q.answered_at ? clock(q.answered_at) : '-' })}</li>
          </ul>
        </>
      )}

      <h3 className="q-section">{t('question.source')}</h3>
      <ul className="small quiet source q-list">
        <li title={t('question.sourceTitle')}>
          {agent
            ? tx('question.fromAgent', { project: sessionProject, agent: <AgentBadge tag={agent} />, session: <span className="mono-inline">{q.session_id}</span> })
            : tx('question.from', { project: sessionProject, session: <span className="mono-inline">{q.session_id}</span> })}
        </li>
        {q.turn_id && <li>{t('question.round', { round: q.turn_id })}</li>}
        <li>{t('question.askedAt', { time: clock(q.created_at) })}</li>
      </ul>

      <ul className="options">
        {options.map((o, i) => {
          const picked = isOpen ? choice === o.key : q.choice === o.key
          return (
            <li key={o.key}>
              <button type="button" className={surfaceClass({ on: picked }, 'option')} aria-pressed={picked} disabled={!isOpen} onClick={() => setChoice(o.key)}>
                <kbd>{o.key}</kbd>
                <span>{o.label}</span>
                {q.recommend === o.key && (
                  <Badge tone="good" fill="solid" className="recommend">
                    {t('question.recommended')}
                  </Badge>
                )}
                <span className="quiet small num">{i + 1}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {isOpen ? (
        <>
          <TextArea
            ref={memoBox}
            className="memo"
            aria-label={t('question.memoLabel')}
            placeholder={t('question.memoPlaceholder')}
            value={memo}
            onChange={event => setMemo(event.target.value)}
            onKeyDown={onMemoKey}
          />
          {error && (
            <Notice tone="error" className="mt-sm">
              {error}
            </Notice>
          )}
          {holdArmed > 0 && Date.now() - holdArmed < HOLD_AGAIN_MS && <p className="quiet small">{t('question.holdAgain')}</p>}
          {forwardedTo && <p className="quiet small">{t('question.forwarded', { session: forwardedTo })}</p>}
          <div className="actions">
            <Button variant="primary" disabled={busy || !choice} onClick={() => void submit(choice, memo)}>
              {choice ? t('question.sendChoice', { key: choice }) : t('question.pickFirst')}
            </Button>
            <Button disabled={busy || !memo.trim()} onClick={() => void submit('', memo)}>
              {t('question.sendMemo')}
            </Button>
            {q.status === 'pending' && (
              <Button disabled={busy} onClick={() => void hold()}>
                {t('palette.qHeld')}
              </Button>
            )}
            <span className="spacer" />
            <span className="quiet small">
              {tx('question.keys', { a: <kbd>a</kbd>, b: <kbd>b</kbd>, one: <kbd>1</kbd>, two: <kbd>2</kbd>, enter: <kbd>Enter</kbd>, h: <kbd>H</kbd>, m: <kbd>M</kbd> })}
            </span>
          </div>
          {peers.length > 0 && (
            <div className="forward">
              <Select compact value={forwardTo} disabled={busy} onChange={event => setForwardTo(event.target.value)} title={t('question.forwardTitle')} aria-label={t('question.forwardTitle')}>
                <option value="">{t('question.forwardPick')}</option>
                {peers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={busy || !forwardTo} onClick={() => void forward()}>
                {t('question.forward')}
              </Button>
            </div>
          )}
        </>
      ) : null}
      {onOpenTask && (
        <Button variant="link" className="mt-sm" onClick={onOpenTask}>
          {t('question.toTask', { task: q.task_title })}
        </Button>
      )}
    </div>
  )
}
