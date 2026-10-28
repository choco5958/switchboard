import { useEffect, useState } from 'react'
import type { AccountInfo, BridgeState, CcrSlot, SessionUsage } from '../../shared/types'
import { Icon } from './Icons'
import { countLabel, flipTheme, isLight, resetText } from './taskInfo'
import { DEFAULT_THEME, themeOf } from './theme'
import { isClaude } from '../../shared/agents'
import { t } from '../../shared/i18n'

// Usage meters are Claude Code's own; other agent CLIs report none.
export function usageOf(state: BridgeState): SessionUsage {
  for (const session of state.sessions.filter(s => isClaude(s.agent))) {
    try {
      const usage = JSON.parse(session.usage || '{}') as SessionUsage
      if (usage.rateLimits?.length || usage.cost) return usage
    } catch {
      // a session that never reported usage
    }
  }
  return {}
}

const ACCOUNT_POLL_MS = 60_000
// ccr status asks the usage API for every slot, so it runs far less often than the files are read.
const MEASURE_MS = 5 * 60_000
const LIVE_MS = 15 * 60_000

// A slot is usable when it is signed in and its limit is not marked as still holding.
export function ccrFree(slot: CcrSlot, now = Date.now()): boolean {
  return slot.email !== '' && slot.until * 1000 <= now
}

export type SlotUsage = { five?: number; week?: number; live: boolean }

// The freshest numbers for a slot: a Claude session on it that reported lately, else what ccr measured.
export function slotUsage(slot: CcrSlot, sessions: BridgeState['sessions'], now = Date.now()): SlotUsage {
  for (const session of sessions) {
    if (!isClaude(session.agent) || now - session.last_seen > LIVE_MS) continue
    try {
      const usage = JSON.parse(session.usage || '{}') as SessionUsage
      if (usage.ccrSlot !== slot.slot || !usage.rateLimits?.length) continue
      const pct = (kind: string) => usage.rateLimits?.find(r => r.kind === kind)?.percentUsed
      return { five: pct('five_hour'), week: pct('seven_day'), live: true }
    } catch {
      // a session that never reported usage
    }
  }
  return { five: slot.fiveHour, week: slot.week, live: false }
}

export function slotTitle(slot: CcrSlot, current: boolean, usage: SlotUsage, now = Date.now()): string {
  const pct = (n: number | undefined) => (n === undefined ? '-' : `${Math.round(n)}%`)
  const time = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const lines = [t('top.ccrSlotTitle', { n: slot.slot, email: slot.email || t('top.ccrNoLogin') })]
  if (current) lines.push(t('top.ccrCurrent'))
  if (slot.until * 1000 > now) lines.push(t('top.ccrSpent', { reset: resetText(slot.until, now) }))
  lines.push(t('top.ccrUsage', { five: pct(usage.five), week: pct(usage.week) }))
  lines.push(usage.live ? t('top.ccrLive') : slot.measuredAt ? t('top.ccrMeasured', { time: time(slot.measuredAt) }) : t('top.ccrUnmeasured'))
  if (slot.measureError) lines.push(t('top.ccrFailed', { error: slot.measureError }))
  return lines.join('\n')
}

function MiniMeter({ label, percent }: { label: string; percent: number | undefined }) {
  const level = percent === undefined ? '' : percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'good'
  return (
    <span className="ccr-meter">
      <span className="quiet">{label}</span>
      <span className="meter-track">
        {percent !== undefined && <span className={`meter-fill ${level}`} style={{ width: `${Math.min(100, percent)}%` }} />}
      </span>
      <span>{percent === undefined ? '-' : `${Math.round(percent)}%`}</span>
    </span>
  )
}

function CcrSlots({ ccr, sessions, onMeasure, measuring }: { ccr: NonNullable<AccountInfo['ccr']>; sessions: BridgeState['sessions']; onMeasure: () => void; measuring: boolean }) {
  return (
    <button className={`ccr-slots ${measuring ? 'measuring' : ''}`} title={t('top.ccrTitle')} onClick={onMeasure}>
      {ccr.slots.map(slot => {
        const usage = slotUsage(slot, sessions)
        const state = slot.email === '' ? 'off' : !ccrFree(slot) ? 'spent' : ''
        return (
          <span key={slot.slot} className={`ccr-slot ${state} ${slot.slot === ccr.current ? 'current' : ''}`} title={slotTitle(slot, slot.slot === ccr.current, usage)}>
            <b>{slot.slot}</b>
            <MiniMeter label={t('top.ccrFive')} percent={usage.five} />
            <MiniMeter label={t('top.ccrWeek')} percent={usage.week} />
          </span>
        )
      })}
    </button>
  )
}

function Meter({ label, percent, reset = '' }: { label: string; percent: number | undefined; reset?: string }) {
  if (percent === undefined) return null
  const level = percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'good'
  return (
    <span className={`meter ${reset ? 'has-reset' : ''}`} title={`${label} ${percent}%${reset ? `, ${reset}` : ''}`}>
      <span className="quiet small">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill ${level}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="small">{percent}%</span>
    </span>
  )
}

export function TopBar({
  state,
  scoped = null,
  connected,
  live = true,
  onSearch,
  onReport,
  onQuestions,
  onToggleSidebar,
  onToggleDock,
  onToggleLive,
}: {
  state: BridgeState
  // The state seen through the chosen project, when one is chosen.
  scoped?: BridgeState | null
  connected: boolean
  live?: boolean
  onSearch: () => void
  onReport: () => void
  onQuestions: () => void
  onToggleSidebar?: () => void
  onToggleDock?: () => void
  onToggleLive?: () => void
}) {
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const measure = () => {
    if (!window.ide.measureAccounts) return
    setMeasuring(true)
    void window.ide
      .measureAccounts()
      .then(next => next && setAccount(next))
      .finally(() => setMeasuring(false))
  }
  useEffect(() => {
    // ccr switches slots and marks limits while the app runs, so read it again now and then.
    const read = () => void window.ide.accountInfo?.().then(setAccount)
    read()
    measure()
    const timers = [setInterval(read, ACCOUNT_POLL_MS), setInterval(measure, MEASURE_MS)]
    return () => timers.forEach(clearInterval)
  }, [])
  const ccr = account?.ccr
  // A project whose sessions are all other agents shows no Claude meters rather than another project's.
  const claudeHere = !scoped || scoped.sessions.length === 0 || scoped.sessions.some(s => isClaude(s.agent))
  const usage = claudeHere ? usageOf(state) : {}
  const five = usage.rateLimits?.find(r => r.kind === 'five_hour')
  const week = usage.rateLimits?.find(r => r.kind === 'seven_day')
  const cost = usage.cost?.totalUsd
  const runningOf = (s: BridgeState) => s.agents.filter(a => a.status === 'running').length
  const pendingOf = (s: BridgeState) => s.questions.filter(q => q.status === 'pending').length
  const running = runningOf(state)
  const pending = pendingOf(state)
  const scopedRunning = scoped ? runningOf(scoped) : null
  const scopedPending = scoped ? pendingOf(scoped) : null
  const theme = themeOf(state.settings.theme)
  const light = isLight(theme)

  const flip = async () => {
    const next = flipTheme(theme, typeof state.settings.darkTheme === 'string' ? state.settings.darkTheme : undefined, DEFAULT_THEME)
    if (!light) await window.ide.bridge('POST', '/settings', { key: 'darkTheme', value: next.lastDark })
    await window.ide.bridge('POST', '/settings', { key: 'theme', value: next.theme })
  }

  return (
    <header className="topbar">
      <span className="brand">
        <BrandMark />
        Switchboard
      </span>
      {ccr ? (
        <CcrSlots ccr={ccr} sessions={state.sessions} onMeasure={measure} measuring={measuring} />
      ) : (
        account && (
          <span className="account" title={t('top.accountTitle', { email: account.email })}>
            <span className="quiet small account-email">{account.email}</span>
            {account.plan && <span className="chip">{account.plan}</span>}
          </span>
        )
      )}
      {usage.model && <span className="chip topbar-model">{usage.model}</span>}
      {/* With ccr the slots above already carry each account's limits. */}
      {!ccr && <Meter label={t('top.fiveHour')} percent={five?.percentUsed} reset={resetText(five?.resetsAt)} />}
      {!ccr && <Meter label={t('top.week')} percent={week?.percentUsed} reset={resetText(week?.resetsAt)} />}
      <Meter label={t('top.context')} percent={usage.contextPercent} />
      {cost !== undefined && <span className="quiet small topbar-cost">{t('top.cost', { cost: `$${cost.toFixed(2)}` })}</span>}
      <button className="chip chip-button" onClick={onReport} title={t('top.reportTitle')}>
        {t('top.report')}
      </button>
      <span className="spacer" />
      <button className="searchbox" onClick={onSearch}>
        <Icon name="search" size={14} /> {t('top.search')} <kbd>⌘K</kbd>
      </button>
      <span className="spacer" />
      <span className={`chip ${(scopedRunning ?? running) > 0 ? 'chip-on' : ''}`}>{countLabel(t('top.agents'), running, scopedRunning)}</span>
      <button className={`chip chip-button ${(scopedPending ?? pending) > 0 ? 'chip-warn' : ''}`} onClick={onQuestions}>
        {countLabel(t('top.decisions'), pending, scopedPending)}
      </button>
      <span className={`chip ${connected ? 'chip-good' : 'chip-bad'}`}>{connected ? t('top.connected') : t('top.disconnected')}</span>
      {onToggleSidebar && (
        <button className="topbar-icon" title={t('top.toggleSidebar')} onClick={onToggleSidebar}>
          <Icon name="sidebar" size={16} />
        </button>
      )}
      {onToggleDock && (
        <button className="topbar-icon" title={t('top.toggleDock')} onClick={onToggleDock}>
          <Icon name="dock" size={16} />
        </button>
      )}
      {onToggleLive && (
        <button
          className={`chip chip-button live ${live ? 'chip-good' : 'chip-warn'}`}
          title={live ? t('top.liveOnTitle') : t('top.liveOffTitle')}
          onClick={onToggleLive}
        >
          {live ? t('top.live') : t('top.paused')}
        </button>
      )}
      <button className="topbar-icon" title={light ? t('top.toDark') : t('top.toLight')} onClick={() => void flip()}>
        <Icon name={light ? 'moon' : 'sun'} size={16} />
      </button>
    </header>
  )
}

// The plug board of the app icon (scripts/icon.mjs): four jacks, one lit in the theme's accent.
function BrandMark() {
  const jacks: [number, number, boolean][] = [
    [4.5, 4.5, false],
    [11.5, 4.5, true],
    [4.5, 11.5, false],
    [11.5, 11.5, false],
  ]
  return (
    <svg className="brand-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" strokeOpacity="0.5" />
      <path d="M8 1v14M1 8h14" stroke="currentColor" strokeOpacity="0.5" />
      {jacks.map(([cx, cy, lit]) =>
        lit ? (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.6" fill="var(--accent)" />
        ) : (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.8" fill="none" stroke="currentColor" />
        ),
      )}
    </svg>
  )
}
