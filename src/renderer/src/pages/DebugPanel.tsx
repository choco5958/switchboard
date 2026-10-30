import { useCallback, useEffect, useRef, useState } from 'react'
import type { DevGit, DevStatus, Session } from '../../../shared/types'
import { fieldErrors, gitErrorText, makeTarget, targetsOf, type DevDraft, type DevTarget } from '../../../shared/devtargets'
import { debugStore, sendable, sessionFor, useDebugStore, waitUntilAnswering, whereTo } from '../debugStore'
import { t } from '../../../shared/i18n'
import { composing } from '../ime'
import { saveSetting } from '../settings'
import { Badge, Button, Card, EmptyState, Input, Notice, Select, TextArea, surfaceClass } from '../ui'

const POLL_MS = 3000
const EMPTY_DRAFT: DevDraft = { name: '', description: '', repo: '', command: '', url: '' }

function hostPort(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Sidebar of the debugging page: direct input to a session, and the dev servers
// to run, restart, update and stop. The list lives in bridge settings ('devTargets').
// The session picked here is the one screen comments go to as well.
export function DebugPanel({ sessions, settings, scope }: { sessions: Session[]; settings: Record<string, unknown>; scope?: string | null }) {
  const debug = useDebugStore()
  const targets = targetsOf(settings.devTargets)
  const pullRestart = settings.devPullRestart === true
  const selected = targets.find(t => t.id === debug.targetId)
  const choices = sendable(sessions, scope, debug.live)
  const session = sessionFor(debug.session, sessions, scope, debug.live)

  const [text, setText] = useState('')
  const [sent, setSent] = useState('')
  const [statuses, setStatuses] = useState<Record<string, DevStatus>>({})
  const [gits, setGits] = useState<Record<string, DevGit>>({})
  const [form, setForm] = useState<{ id: string; draft: DevDraft } | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof DevDraft, string>>>({})
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [pullOut, setPullOut] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const logBox = useRef<HTMLPreElement>(null)

  const poll = useCallback(async () => {
    const list = targetsRef.current
    const rows = await Promise.all(list.map(t => window.ide.devStatus(t)))
    setStatuses(Object.fromEntries(rows.map(r => [r.id, r])))
  }, [])

  const checkGit = useCallback(async (target: DevTarget) => {
    const git = await window.ide.devGit(target.repo)
    setGits(current => ({ ...current, [target.id]: git }))
  }, [])

  const targetKey = targets.map(t => `${t.id}:${t.url}:${t.repo}`).join('|')
  useEffect(() => {
    void poll()
    for (const t of targetsRef.current) void checkGit(t)
    const timer = setInterval(() => void poll(), POLL_MS)
    const off = window.ide.onDevChange(() => void poll())
    return () => {
      clearInterval(timer)
      off()
    }
  }, [targetKey, poll, checkGit])

  useEffect(() => {
    setConfirmDelete(false)
    setPullOut('')
    setMessage('')
  }, [debug.targetId])

  // The browser's error page asks for a target with its address filled in.
  useEffect(() => {
    if (!debug.addTarget) return
    setErrors({})
    setSaveError('')
    setForm({ id: '', draft: { ...EMPTY_DRAFT, url: debug.addTarget.url } })
  }, [debug.addTarget?.seq])

  useEffect(() => {
    if (!showLog || !selected) return
    const id = selected.id
    const read = () => void window.ide.devLog(id).then(setLog)
    read()
    const timer = setInterval(read, 1500)
    return () => clearInterval(timer)
  }, [showLog, selected?.id])

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  }, [log])

  const saveTargets = (list: DevTarget[]) => saveSetting('devTargets', list)

  const select = (target: DevTarget) => {
    debugStore.setTarget(target.id)
    debugStore.openUrl(target.url)
    void checkGit(target)
  }

  const sendDirect = async () => {
    const body = text.trim()
    if (!body || !session) return
    const reply = await window.ide.send(session.id, body, '직접 입력', '')
    if (!reply.ok) return setSent(t('linear.sendFailed', { error: String(reply.json.error ?? '') }))
    setText('')
    setSent(t('dev.sent', { id: session.id.slice(0, 8) }))
  }

  const submitForm = async () => {
    if (!form) return
    const problems = fieldErrors(form.draft, targets, form.id)
    setErrors(problems)
    setSaveError('')
    if (Object.keys(problems).length) return
    const id = form.id || `t${Date.now().toString(36)}`
    const target = makeTarget(form.draft, id)
    const list = form.id ? targets.map(t => (t.id === id ? target : t)) : [...targets, target]
    const reply = await saveTargets(list)
    if (!reply.ok) return setSaveError(t('common.saveFailed', { error: String(reply.json.error ?? '') }))
    setForm(null)
    select(target)
  }

  // After a start, open the page once it answers.
  const openWhenReady = async (target: DevTarget) => {
    const answered = await waitUntilAnswering(target, status => setStatuses(current => ({ ...current, [target.id]: status })))
    if (answered) debugStore.openUrl(target.url, true)
    return answered
  }

  const act = async (label: string, work: () => Promise<string>) => {
    setBusy(label)
    setMessage('')
    try {
      setMessage(await work())
    } finally {
      setBusy('')
    }
  }

  const restart = (target: DevTarget) =>
    act('restart', async () => {
      const result = await window.ide.devRestart(target)
      if (!result.ok) return result.out
      const answered = await openWhenReady(target)
      return answered ? t('dev.restarted') : t('dev.restartedSilent')
    })

  const pull = (target: DevTarget) =>
    act('pull', async () => {
      const result = await window.ide.devPull(target.repo)
      setPullOut(result.out || (result.ok ? t('dev.pullNothing') : t('dev.pullFailedShort')))
      await checkGit(target)
      if (!result.ok) return t('dev.pullFailed')
      if (!pullRestart) return t('dev.pulled')
      const again = await window.ide.devRestart(target)
      if (!again.ok) return again.out
      const answered = await openWhenReady(target)
      return answered ? t('dev.pulledRestarted') : t('dev.pulledRestartedSilent')
    })

  const stop = (target: DevTarget) =>
    act('stop', async () => {
      const result = await window.ide.devStop(target.id)
      await poll()
      return result.out
    })

  const remove = async (target: DevTarget) => {
    if (!confirmDelete) return setConfirmDelete(true)
    await window.ide.devStop(target.id)
    await saveTargets(targets.filter(t => t.id !== target.id))
    debugStore.setTarget('')
    setConfirmDelete(false)
  }

  const status = selected ? statuses[selected.id] : undefined
  const git = selected ? gits[selected.id] : undefined

  return (
    <section className="debug-panel">
      <h2>{t('rail.debug')}</h2>

      <div className="direct">
        <TextArea
          className="direct-input"
          aria-label={t('dev.directPlaceholder')}
          placeholder={t('dev.directPlaceholder')}
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !composing(event)) void sendDirect()
          }}
        />
        <div className="direct-row">
          <span className="small quiet direct-where">{t('dev.sendTo', { where: session ? whereTo(session, selected) : t('dev.noLiveSession') })}</span>
          <Button variant="primary" size="sm" disabled={!text.trim() || !session} onClick={() => void sendDirect()}>
            {t('dev.send')}
          </Button>
        </div>
        {choices.length > 1 && (
          <Select
            compact
            className="wide"
            title={t('dev.sessionTitle')}
            aria-label={t('dev.sessionTitle')}
            value={session?.id ?? ''}
            onChange={event => debugStore.setSession(event.target.value)}
          >
            {choices.map(s => (
              <option key={s.id} value={s.id}>
                {s.project} ({s.id.slice(0, 8)})
              </option>
            ))}
          </Select>
        )}
        {!session && <p className="small quiet">{scope ? t('dev.noSessionIn', { project: scope }) : t('dev.noSessionNow')}</p>}
        {sent && <p className="small quiet">{sent}</p>}
      </div>

      <div className="sidebar-meta dev-head">
        <h3>{t('dev.servers')}</h3>
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            setErrors({})
            setSaveError('')
            setForm({ id: '', draft: { ...EMPTY_DRAFT } })
          }}
        >
          {t('dev.add')}
        </Button>
      </div>
      {targets.length === 0 && !form && <EmptyState className="small">{t('dev.empty')}</EmptyState>}
      <div className="dev-list">
        {targets.map(target => {
          const s = statuses[target.id]
          const g = gits[target.id]
          // The dot's colour and the word beside it say the same thing.
          const state = s?.responding ? 'good' : s?.running || s?.listening ? 'warn' : 'off'
          const word = state === 'good' ? t('dev.responding') : state === 'warn' ? t('dev.notResponding') : t('dev.down')
          return (
            <button
              key={target.id}
              type="button"
              className={surfaceClass({ pad: 'sm', sunk: true, interactive: true, on: target.id === debug.targetId }, 'dev-target')}
              onClick={() => select(target)}
            >
              <div className="dev-target-title">
                {target.name} {g?.branch && <span className="quiet">{g.branch}</span>} {target.port !== null && <span className="quiet mono-inline">({target.port})</span>}{' '}
                <span className={`dev-state-mark ${state}`}>{word}</span>
              </div>
              <div className="quiet small mono-inline">
                {hostPort(target.url)}, {g?.commit || 'HEAD'}
              </div>
            </button>
          )
        })}
      </div>

      {form && (
        <Card sunk className="dev-form">
          <h3>{form.id ? t('dev.editTitle') : t('dev.newTitle')}</h3>
          {(
            [
              ['name', t('dev.fieldName'), t('dev.fieldNameExample')],
              ['description', t('dev.fieldDescription'), t('dev.fieldDescriptionExample')],
              ['repo', t('dev.fieldRepo'), '/Users/me/projects/app'],
              ['command', t('dev.fieldCommand'), 'pnpm dev --port 8980'],
              ['url', t('dev.fieldUrl'), 'http://127.0.0.1:8980'],
            ] as [keyof DevDraft, string, string][]
          ).map(([key, label, placeholder]) => (
            <label key={key} className={`field ${errors[key] ? 'field-bad' : ''}`}>
              <span className="small quiet">{label}</span>
              <Input
                name={key}
                mono={key === 'repo' || key === 'command' || key === 'url'}
                placeholder={placeholder}
                value={form.draft[key]}
                aria-invalid={!!errors[key]}
                onChange={event => {
                  setForm({ ...form, draft: { ...form.draft, [key]: event.target.value } })
                  if (errors[key]) setErrors(current => ({ ...current, [key]: undefined }))
                }}
              />
              {errors[key] && <span className="small error field-error">{errors[key]}</span>}
            </label>
          ))}
          {saveError && (
            <Notice tone="error" className="small">
              {saveError}
            </Notice>
          )}
          <div className="actions dev-form-actions">
            <Button variant="primary" onClick={() => void submitForm()}>
              {t('picker.save')}
            </Button>
            <Button onClick={() => setForm(null)}>{t('picker.cancel')}</Button>
          </div>
        </Card>
      )}

      {selected && !form && (
        <Card sunk className="dev-detail">
          <dl className="dev-facts">
            <dt>{t('dev.target')}</dt>
            <dd>
              <b>{selected.name}</b>
              {selected.description && <div className="quiet small">{selected.description}</div>}
            </dd>
            <dt>{t('dev.fieldRepo')}</dt>
            <dd className="mono-inline small">{selected.repo}</dd>
            <dt>{t('props.branch')}</dt>
            <dd>
              {git?.ok ? <span className="mono-inline">{git.branch}</span> : <span className="quiet small" title={git?.error}>{git ? gitErrorText(git.error) || t('dev.checking') : t('dev.checking')}</span>}{' '}
              {git?.ok && <Badge tone="good">{t('dev.gitOk')}</Badge>}{' '}
              <Button variant="link" size="sm" className="inline-link" onClick={() => void checkGit(selected)}>
                {t('dev.recheck')}
              </Button>
            </dd>
            <dt>{t('dev.commit')}</dt>
            <dd>
              {git?.ok ? (
                <>
                  <span className="mono-inline">{git.commit}</span> <span className="small quiet">{git.subject}</span>
                </>
              ) : (
                <span className="quiet small">{t('linear.none')}</span>
              )}
            </dd>
            <dt>{t('dev.command')}</dt>
            <dd className="mono-inline small">{selected.command}</dd>
            <dt>{t('dev.fieldUrl')}</dt>
            <dd>
              <Button variant="link" size="sm" className="inline-link mono-inline" onClick={() => debugStore.openUrl(selected.url)}>
                {selected.url}
              </Button>{' '}
              {status && <Badge tone={status.responding ? 'good' : 'bad'}>{status.responding ? t('dev.responding') : t('dev.notResponding')}</Badge>}
            </dd>
          </dl>

          <div className="dev-actions">
            <Button
              size="sm"
              onClick={() => {
                setErrors({})
                setSaveError('')
                setForm({ id: selected.id, draft: { name: selected.name, description: selected.description, repo: selected.repo, command: selected.command, url: selected.url } })
              }}
            >
              {t('dev.edit')}
            </Button>
            <Button size="sm" variant={confirmDelete ? 'danger' : 'default'} onClick={() => void remove(selected)}>
              {confirmDelete ? t('dev.deleteConfirm') : t('dev.delete')}
            </Button>
            <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void restart(selected)}>
              {busy === 'restart' ? t('dev.restarting') : t('dev.restart')}
            </Button>
            <Button size="sm" disabled={!!busy} title="git pull --ff-only" onClick={() => void pull(selected)}>
              {busy === 'pull' ? t('dev.pulling') : t('dev.pull')}
            </Button>
            <Button size="sm" disabled={!!busy || !status?.running} onClick={() => void stop(selected)}>
              {t('dev.stop')}
            </Button>
          </div>
          <label className="check-row small">
            <input
              type="checkbox"
              checked={pullRestart}
              onChange={event => void saveSetting('devPullRestart', event.target.checked)}
            />
            {t('dev.pullRestart')}
          </label>
          <div className="small dev-state">
            {selected.port !== null && <span className={status?.listening ? 'good' : 'quiet'}>:{selected.port} {status?.listening ? t('dev.up') : t('dev.down')}</span>}
            {status?.listening && !status.running && <span className="quiet"> {t('dev.notOurs')}</span>}
            {status?.running && status.pid && <span className="quiet"> pid {status.pid}</span>}
            {!status?.running && status?.exitCode !== null && status?.exitCode !== undefined && <span className="quiet"> {t('dev.lastExit', { code: status.exitCode })}</span>}
          </div>
          {message && <p className="small">{message}</p>}
          {pullOut && <pre className="dev-out">{pullOut}</pre>}
          <Button variant="link" size="sm" className="mt-sm" aria-expanded={showLog} onClick={() => setShowLog(on => !on)}>
            {showLog ? t('dev.hideLog') : t('dev.showLog')}
          </Button>
          {showLog && (
            <pre ref={logBox} className="dev-out dev-log">
              {log.length ? log.join('\n') : t('dev.noLog')}
            </pre>
          )}
        </Card>
      )}
    </section>
  )
}
