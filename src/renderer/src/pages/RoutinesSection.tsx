import { useEffect, useState } from 'react'
import type { Routine, RoutineRun, RoutineSchedule } from '../../../shared/types'
import type { ProjectInfo } from '../../../shared/projects'
import { t, type Key } from '../../../shared/i18n'
import { useToast } from '../parts'
import { clock } from '../model'
import { MIN_INTERVAL_MINUTES, ROUTINE_FAIL_LIMIT } from '../../../../bridge/schedule.ts'
import { agentLabel, routineAgents, type CustomAgent } from '../../../shared/agents'
import { Button, Card, EmptyState, Input, More, Notice, Select, TextArea, cx } from '../ui'

// Settings: scheduled prompts (bridge/schedule.ts). Each goes to a connected Claude Code
// session of its project at its time; with none, the app opens one there.

type Draft = { id: number; name: string; project: string; cwd: string; agent: string; prompt: string; kind: RoutineSchedule['kind']; time: string; every: string; at: string; runMissed: boolean }

const EMPTY: Draft = { id: 0, name: '', project: '', cwd: '', agent: 'claude', prompt: '', kind: 'daily', time: '09:00', every: '60', at: '', runMissed: false }

const STATUS_KEYS: Record<RoutineRun['status'], Key> = {
  waiting: 'routines.status.waiting',
  sent: 'routines.status.sent',
  done: 'routines.status.done',
  quiet: 'routines.status.quiet',
  failed: 'routines.status.failed',
  skipped: 'routines.status.skipped',
  missed: 'routines.status.missed',
}

function parse(routine: Routine): RoutineSchedule | null {
  try {
    return JSON.parse(routine.schedule) as RoutineSchedule
  } catch {
    return null
  }
}

export function scheduleLabel(schedule: RoutineSchedule | null): string {
  if (!schedule) return '-'
  if (schedule.kind === 'daily') return t('routines.daily', { time: schedule.time })
  if (schedule.kind === 'weekdays') return t('routines.weekdays', { time: schedule.time })
  if (schedule.kind === 'interval') return t('routines.interval', { n: schedule.every })
  return t('routines.once', { at: schedule.at.replace('T', ' ') })
}

// Why a draft cannot be saved yet, the first missing piece; null when it can. The save button
// stays off until then, and this line says what to fill in, rather than a silent grey button.
// The bridge checks the same things (bridge/schedule.ts parseSchedule, POST /routines).
export function whyNotSave(draft: Pick<Draft, 'name' | 'project' | 'prompt' | 'kind' | 'time' | 'every' | 'at'>, now = Date.now()): string | null {
  if (!draft.name.trim()) return t('routines.needName')
  if (!draft.project) return t('routines.needProject')
  if (!draft.prompt.trim()) return t('routines.needPrompt')
  if ((draft.kind === 'daily' || draft.kind === 'weekdays') && !/^\d{1,2}:\d{2}$/.test(draft.time)) return t('routines.needTime')
  if (draft.kind === 'interval' && !(Math.floor(Number(draft.every)) >= MIN_INTERVAL_MINUTES)) return t('routines.needInterval', { n: MIN_INTERVAL_MINUTES })
  if (draft.kind === 'once') {
    if (!draft.at) return t('routines.needAt')
    if (new Date(draft.at).getTime() <= now) return t('routines.pastAt')
  }
  return null
}

// Why no routine can be added now: no background server to keep it, or no project folder to run in.
export function whyNotAdd(connected: boolean, folders: number): string | null {
  if (!connected) return t('routines.offline')
  if (folders === 0) return t('routines.noFolders')
  return null
}

function draftOf(routine: Routine): Draft {
  const s = parse(routine)
  return {
    id: routine.id,
    name: routine.name,
    project: routine.project,
    cwd: routine.cwd,
    agent: routine.agent || 'claude',
    prompt: routine.prompt,
    kind: s?.kind ?? 'daily',
    time: s && 'time' in s ? s.time : '09:00',
    every: s?.kind === 'interval' ? String(s.every) : '60',
    at: s?.kind === 'once' ? s.at : '',
    runMissed: routine.missed === 'run-once',
  }
}

export function RoutinesSection({ routines, runs, projects, customs }: { routines: Routine[]; runs: RoutineRun[]; projects: ProjectInfo[]; customs: CustomAgent[] }) {
  // Which agent CLIs are installed, for the agent a routine goes to.
  const [found, setFound] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    void window.ide.detectAgents?.().then(detected => setFound(detected.found))
  }, [])
  // Routines live in the background server; without it nothing here can be saved or run.
  const [connected, setConnected] = useState(true)
  useEffect(() => {
    void window.ide.connected?.().then(setConnected, () => undefined)
    return window.ide.onConnection?.(setConnected)
  }, [])
  const toast = useToast()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  // Projects taken off the sidebar list still run routines, so they stay pickable here.
  const folders = projects.filter(p => p.cwd)
  // A routine whose project no longer has a known folder keeps its own project and folder.
  const editedProject = draft?.id ? routines.find(r => r.id === draft.id)?.project : undefined
  const own = editedProject && !folders.some(p => p.name === editedProject) ? editedProject : null
  const set = (patch: Partial<Draft>) => setDraft(current => (current ? { ...current, ...patch } : current))
  const addBlocked = whyNotAdd(connected, folders.length)
  const saveBlocked = !connected ? t('routines.offline') : draft ? whyNotSave(draft) : null

  const call = async (path: string, body?: unknown) => {
    const reply = await window.ide.bridge('POST', path, body)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
    return reply.ok
  }

  const save = async () => {
    if (!draft) return
    const project = folders.find(p => p.name === draft.project)
    const schedule =
      draft.kind === 'interval' ? { kind: 'interval', every: Number(draft.every) } : draft.kind === 'once' ? { kind: 'once', at: draft.at } : { kind: draft.kind, time: draft.time }
    const ok = await call('/routines', {
      id: draft.id || undefined,
      name: draft.name,
      prompt: draft.prompt,
      project: draft.project,
      agent: draft.agent,
      cwd: project?.cwd ?? (draft.project === own ? draft.cwd : ''),
      schedule,
      missed: draft.runMissed ? 'run-once' : 'skip',
    })
    if (ok) setDraft(null)
  }

  const toggle = (r: Routine) => {
    const s = parse(r)
    void call('/routines', { ...r, schedule: s, enabled: r.enabled !== 1 })
  }

  return (
    <section id="settings-routines" className="settings-row routines">
      <h2>{t('routines.title')}</h2>
      <p className="quiet small">
        {t('routines.hint')}
        <More>{t('routines.hintMore')}</More>
      </p>
      {!connected && (
        <Notice tone="warn">
          <span className="small">{t('routines.offline')}</span>
        </Notice>
      )}
      {routines.length === 0 && !draft && <EmptyState>{t('routines.empty')}</EmptyState>}
      {routines.map(r => {
        const last = [...runs].reverse().find(run => run.routine_id === r.id)
        return (
          <Card key={r.id} pad="sm" className={cx('routine-row', !r.enabled && 'off')}>
            <div className="routine-head">
              <strong>{r.name}</strong>
              <span className="quiet small">
                {r.project}
                {r.agent && r.agent !== 'claude' ? ` (${agentLabel(r.agent, customs)})` : ''}, {scheduleLabel(parse(r))}
                {r.enabled && r.next_at ? `, ${t('routines.next', { at: clock(r.next_at) })}` : ''}
              </span>
              <span className="spacer" />
              <label className="check-row small">
                <input type="checkbox" checked={r.enabled === 1} onChange={() => toggle(r)} />
                {t('routines.enabled')}
              </label>
              <Button variant="link" size="sm" disabled={!connected} title={connected ? undefined : t('routines.offline')} onClick={() => void call(`/routines/${r.id}/run`)}>
                {t('routines.runNow')}
              </Button>
              <Button variant="link" size="sm" onClick={() => setDraft(draftOf(r))}>
                {t('routines.edit')}
              </Button>
              <Button
                variant="link"
                size="sm"
                className={deleting === r.id ? 'error' : undefined}
                onClick={() => {
                  if (deleting !== r.id) return setDeleting(r.id)
                  setDeleting(null)
                  void call(`/routines/${r.id}/delete`)
                }}
              >
                {deleting === r.id ? t('routines.deleteConfirm') : t('routines.delete')}
              </Button>
            </div>
            {r.failed_off === 1 && !r.enabled && <div className="small error">{t('routines.failedOff', { n: ROUTINE_FAIL_LIMIT })}</div>}
            {last && (
              <div className="quiet small routine-last" title={last.result || last.failure}>
                {t('routines.last', { at: clock(last.scheduled_for), status: t(STATUS_KEYS[last.status]) })}
                {(last.failure || last.result) && `: ${(last.failure || last.result).split('\n')[0]}`}
              </div>
            )}
          </Card>
        )
      })}
      {draft ? (
        <Card className="routine-form">
          <Input aria-label={t('routines.name')} placeholder={t('routines.name')} value={draft.name} onChange={e => set({ name: e.target.value })} />
          <Select aria-label={t('routines.pickProject')} value={draft.project} onChange={e => set({ project: e.target.value })}>
            <option value="">{t('routines.pickProject')}</option>
            {own && <option value={own}>{own}</option>}
            {folders.map(p => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </Select>
          <label className="small">
            {t('routines.agent')}{' '}
            <Select compact value={draft.agent} onChange={e => set({ agent: e.target.value })}>
              {routineAgents(found, customs, draft.agent).map(a => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </label>
          <TextArea aria-label={t('routines.prompt')} placeholder={t('routines.prompt')} value={draft.prompt} onChange={e => set({ prompt: e.target.value })} />
          <div className="routine-when">
            <Select compact aria-label={t('routines.when')} value={draft.kind} onChange={e => set({ kind: e.target.value as Draft['kind'] })}>
              <option value="daily">{t('routines.kind.daily')}</option>
              <option value="weekdays">{t('routines.kind.weekdays')}</option>
              <option value="interval">{t('routines.kind.interval')}</option>
              <option value="once">{t('routines.kind.once')}</option>
            </Select>
            {(draft.kind === 'daily' || draft.kind === 'weekdays') && (
              <Input compact type="time" aria-label={t('routines.when')} value={draft.time} onChange={e => set({ time: e.target.value })} />
            )}
            {draft.kind === 'interval' && (
              <label className="small">
                <Input compact type="number" min={5} value={draft.every} onChange={e => set({ every: e.target.value })} /> {t('routines.minutes')}
              </label>
            )}
            {draft.kind === 'once' && <Input compact type="datetime-local" aria-label={t('routines.when')} value={draft.at} onChange={e => set({ at: e.target.value })} />}
            <label className="check-row small" title={t('routines.runMissedTitle')}>
              <input type="checkbox" checked={draft.runMissed} onChange={e => set({ runMissed: e.target.checked })} />
              {t('routines.runMissed')}
            </label>
          </div>
          <div className="actions">
            <Button variant="primary" disabled={saveBlocked !== null} aria-describedby={saveBlocked ? 'routine-why' : undefined} onClick={() => void save()}>
              {t('routines.save')}
            </Button>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            {saveBlocked && (
              <span id="routine-why" className="quiet small routine-why">
                {saveBlocked}
              </span>
            )}
          </div>
        </Card>
      ) : (
        <div className="routine-add">
          <Button variant="link" className="mt-sm" disabled={addBlocked !== null} aria-describedby={addBlocked ? 'routine-add-why' : undefined} onClick={() => setDraft({ ...EMPTY, project: folders[0]?.name ?? '' })}>
            {t('routines.add')}
          </Button>
          {/* Offline already shows above; a missing project folder is said here, by the button it holds back. */}
          {addBlocked && connected && (
            <span id="routine-add-why" className="quiet small routine-why">
              {addBlocked}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
