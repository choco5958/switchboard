import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Question } from '../../shared/types'
import { renderMarkdown } from './markdown'
import { clock, keyAction, keyWorks, optionKeys, optionsOf, type Reach } from './model'
import { AgentBadge, useToast } from './parts'
import { SEND_DELAY_MS, draftOf, isWaiting, queueAnswer, subscribe, takeBack } from './outbox'
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
  onReopen,
  onOpenTask,
  keysAnywhere = false,
}: {
  q: Question
  agent?: AgentTag // the agent CLI that asked, once other agents than Claude are around
  sessionProject: string
  reach?: Reach // whether the session can take the answer now
  peers?: { id: string; name: string; label: string }[] // connected sessions other than the asker, to hand the question to
  onDone: () => void
  onReopen?: () => void // opens this question again (after Undo)
  onOpenTask: (() => void) | null
  keysAnywhere?: boolean // settings: DECISION_KEYS_KEY
}) {
  const options = optionsOf(q)
  const keys = optionKeys(options)
  const toast = useToast()
  // An answer taken back with Undo comes back here as it was.
  const [choice, setChoice] = useState<string>(() => draftOf(q.id)?.choice ?? '')
  const [memo, setMemo] = useState(() => draftOf(q.id)?.memo ?? '')
  // Answered here a moment ago and not gone yet (outbox.ts): no second answer meanwhile.
  const sending = useSyncExternalStore(subscribe, () => isWaiting(q.id))
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

  // The answer waits SEND_DELAY_MS in the app (outbox.ts) while the toast offers Undo; the next
  // question opens at once. Once it has gone the toast says so, or says why it could not.
  const submit = (picked: string, note: string) => {
    if (!picked && !note.trim()) return setError(t('question.needChoice'))
    setError('')
    const id = q.id
    queueAnswer(id, { choice: picked, memo: note }, async () => {
      const reply = await window.ide.answer(id, picked, note)
      if (reply.ok) toast(t('question.sent', { id }))
      else toast(t('question.sendFailedId', { id, error: String(reply.json.error ?? t('question.sendFailed')) }), 'bad')
    })
    const undo = () => {
      if (!takeBack(id)) return
      toast(t('question.undone', { id }), 'info')
      onReopen?.()
    }
    toast(t('question.sending', { id, s: SEND_DELAY_MS / 1000 }), 'info', { label: t('common.undo'), run: undo }, SEND_DELAY_MS)
    onDone()
  }

  // Opened again while its answer still waits: Undo here too, and the card takes the answer back.
  const undoHere = () => {
    const draft = takeBack(q.id)
    if (!draft) return
    setChoice(draft.choice)
    setMemo(draft.memo)
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
    if (!isOpen || busy || sending || typing || composing(event) || event.metaKey || event.ctrlKey || event.altKey) return
    const action = keyAction(event.key, options)
    if (action.type === 'none') return
    event.preventDefault()
    if (action.type === 'choose') setChoice(action.key)
    if (action.type === 'send') submit(choice, memo)
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
      if (!sending) submit(choice, memo)
    }
    if (event.key === 'Escape') memoBox.current?.blur()
  }


  // The keys that really work on this card: each option's own key first, then the numbers.
  const ownKeys = new Set(options.map(o => o.key))
  const pickKeys = options.flatMap(o => keys.get(o.key) ?? []).sort((a, b) => Number(!ownKeys.has(a)) - Number(!ownKeys.has(b)))
  const recommended = options.find(o => o.key === q.recommend)

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

      {/* A reason for a key that is not among the options still shows, on its own line. */}
      {q.reason && !recommended && (
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

      {/* The options, once: each row shows the keys that pick it, the recommended mark and why. */}
      <ul className="options">
        {options.map(o => {
          const picked = isOpen ? choice === o.key : q.choice === o.key
          return (
            <li key={o.key}>
              <button type="button" className={surfaceClass({ on: picked }, 'option')} aria-pressed={picked} disabled={!isOpen || sending} onClick={() => setChoice(o.key)}>
                {isOpen && (
                  <span className="option-keys">
                    {(keys.get(o.key) ?? []).map(k => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                )}
                <span className="option-text">
                  <span>{o.label}</span>
                  {o === recommended && q.reason && <span className="option-note quiet small">{q.reason}</span>}
                </span>
                {o === recommended && (
                  <Badge tone="good" fill="solid" className="recommend">
                    {t('question.recommended')}
                  </Badge>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {isOpen ? (
        <>
          {sending && (
            <Notice
              tone="info"
              className="q-sending"
              action={
                <Button size="sm" onClick={undoHere}>
                  {t('common.undo')}
                </Button>
              }
            >
              {t('question.queued')}
            </Notice>
          )}
          <TextArea
            ref={memoBox}
            className="memo"
            aria-label={t('question.memoLabel')}
            placeholder={t('question.memoPlaceholder')}
            value={memo}
            disabled={sending}
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
            <Button variant="primary" disabled={busy || sending || !choice} onClick={() => submit(choice, memo)}>
              {choice ? t('question.sendChoice', { key: choice }) : t('question.pickFirst')}
            </Button>
            <Button disabled={busy || sending || !memo.trim()} onClick={() => submit('', memo)}>
              {t('question.sendMemo')}
            </Button>
            {q.status === 'pending' && (
              <Button disabled={busy || sending} onClick={() => void hold()}>
                {t('palette.qHeld')}
              </Button>
            )}
            <span className="spacer" />
            <span className="key-hints quiet small">
              {pickKeys.length > 0 && (
                <span>
                  {tx('question.keysPick', {
                    keys: (
                      <>
                        {pickKeys.map((k, i) => (
                          <Fragment key={k}>
                            {i > 0 && ' '}
                            <kbd>{k}</kbd>
                          </Fragment>
                        ))}
                      </>
                    ),
                  })}
                </span>
              )}
              <span>{tx('question.keysSend', { enter: <kbd>Enter</kbd> })}</span>
              {keyWorks('h', options) && <span>{tx('question.keysHold', { h: <kbd>H</kbd> })}</span>}
              {keyWorks('m', options) && <span>{tx('question.keysMemo', { m: <kbd>M</kbd> })}</span>}
            </span>
          </div>
          {peers.length > 0 && (
            <div className="forward">
              <Select compact value={forwardTo} disabled={busy || sending} onChange={event => setForwardTo(event.target.value)} title={t('question.forwardTitle')} aria-label={t('question.forwardTitle')}>
                <option value="">{t('question.forwardPick')}</option>
                {peers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={busy || sending || !forwardTo} onClick={() => void forward()}>
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

      {/* Where it came from: for looking up, not for answering, so last and quiet. */}
      <footer className="q-source quiet small" title={t('question.sourceTitle')}>
        <span className="q-source-label">{t('question.source')}</span>
        <span>
          {agent
            ? tx('question.fromAgent', { project: sessionProject, agent: <AgentBadge tag={agent} />, session: <span className="mono-inline">{q.session_id}</span> })
            : tx('question.from', { project: sessionProject, session: <span className="mono-inline">{q.session_id}</span> })}
        </span>
        {q.turn_id && <span>{t('question.round', { round: q.turn_id })}</span>}
        <span>{t('question.askedAt', { time: clock(q.created_at) })}</span>
      </footer>
    </div>
  )
}
