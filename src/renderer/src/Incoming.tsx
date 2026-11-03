import { useEffect, useRef, useState } from 'react'
import type { Question } from '../../shared/types'
import { t } from '../../shared/i18n'
import { sendAnswer } from './answer'
import { optionsOf } from './model'
import { useToast } from './parts'
import { Badge, Button, IconButton, cx } from './ui'

// A question that arrives while the person looks at something else (another session, home is
// excluded since it lists every question) comes up in the corner, answerable with one press or
// opened in its session. Questions there before the app started never pop up; "Later" puts one
// away, and it still waits in home and in its sidebar row.
export function Incoming({
  pending,
  ready,
  watching,
  quiet,
  where,
  onOpen,
}: {
  pending: Question[]
  ready: boolean // the first state has come: what is there then is not new
  watching: string | null // the session on screen: its own questions show there
  quiet: boolean // home is on screen and lists every question
  where: (q: Question) => string
  onOpen: (q: Question) => void
}) {
  const toast = useToast()
  const seen = useRef<Set<number> | null>(null)
  const [shown, setShown] = useState<Question | null>(null)

  useEffect(() => {
    if (!ready) return
    if (seen.current === null) {
      seen.current = new Set(pending.map(q => q.id))
      return
    }
    const fresh = pending.filter(q => !seen.current!.has(q.id))
    for (const q of fresh) seen.current.add(q.id)
    const latest = fresh.filter(q => q.session_id !== watching).at(-1)
    if (latest) setShown(latest)
  }, [pending, watching, ready])

  // Gone once answered elsewhere, or once the person opened its session.
  const current = !quiet && shown && pending.some(q => q.id === shown.id) && shown.session_id !== watching ? shown : null
  if (!current) return null
  const options = optionsOf(current)
  return (
    <aside className="incoming" role="alertdialog" aria-label={t('incoming.label', { where: where(current) })}>
      <div className="incoming-head small">
        <span className="incoming-dot" aria-hidden="true" />
        <b>{t('incoming.title')}</b>
        <span className="quiet">{where(current)}</span>
        <span className="spacer" />
        <IconButton icon="close" size="sm" label={t('incoming.later')} onClick={() => setShown(null)} />
      </div>
      <h3 className="incoming-question">{current.question}</h3>
      {current.reason && <p className="quiet small">{current.reason}</p>}
      <div className="incoming-options">
        {options.map(o => (
          <Button
            key={o.key}
            size="sm"
            className={cx('quick-option', o.key === current.recommend && 'recommended')}
            title={o.label}
            onClick={() => {
              sendAnswer(current.id, o.key, '', toast)
              setShown(null)
            }}
          >
            <span className="mono-inline quick-key">{o.key}</span>
            <span className="quick-label">{o.label}</span>
            {o.key === current.recommend && (
              <Badge tone="good" fill="solid">
                {t('question.recommended')}
              </Badge>
            )}
          </Button>
        ))}
      </div>
      <div className="incoming-foot small">
        <Button variant="link" size="sm" onClick={() => onOpen(current)}>
          {t('incoming.open')}
        </Button>
        <span className="spacer" />
        <Button variant="ghost" size="sm" onClick={() => setShown(null)}>
          {t('incoming.later')}
        </Button>
      </div>
    </aside>
  )
}
