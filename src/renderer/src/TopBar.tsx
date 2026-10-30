import { useEffect, useState } from 'react'
import type { AccountInfo, BridgeState, CcrSlot, SessionUsage } from '../../shared/types'
import { OPEN_CLAUDE_SLOT, refreshDaysLeft } from '../../shared/ccr'
import { Icon } from './Icons'
import { countLabel, flipTheme, isLight, resetText } from './taskInfo'
import { DEFAULT_THEME, themeOf } from './theme'
import { isClaude } from '../../shared/agents'
import { LOCALE_TAG, getLang, t } from '../../shared/i18n'
import { saveSetting } from './settings'
import { Badge, Chip, IconButton } from './ui'
import { waitParts, type WaitCount } from './waiting'
import { UpdateChip } from './flows'

// The search key as this system writes it (App.tsx takes both).
const SEARCH_KEY = /Mac/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'

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
const WARN_DAYS = 3

// A slot is usable when it is signed in and its limit is not marked as still holding.
export function ccrFree(slot: CcrSlot, now = Date.now()): boolean {
  return signedIn(slot) && slot.until * 1000 <= now
}

// A year token logs in without an email in the slot's config, so either one counts.
function signedIn(slot: CcrSlot): boolean {
  return slot.email !== '' || slot.token === true
}

export type SlotToken = { kind: 'year' } | { kind: 'days'; days: number; warn: boolean } | { kind: 'expired' } | { kind: 'none' }

// A year token outlives logins, so it wins. Otherwise the login's refresh token is what runs out.
export function slotToken(slot: CcrSlot, now = Date.now()): SlotToken {
  if (slot.token) return { kind: 'year' }
  if (slot.email === '' || slot.refreshExpiresAt === undefined) return { kind: 'none' }
  const days = refreshDaysLeft(slot.refreshExpiresAt, now)
  return days < 0 ? { kind: 'expired' } : { kind: 'days', days, warn: days <= WARN_DAYS }
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
  const time = (sec: number) => new Date(sec * 1000).toLocaleString(LOCALE_TAG[getLang()], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const lines = [t('top.ccrSlotTitle', { n: slot.slot, email: slot.email || t('top.ccrNoLogin') })]
  if (current) lines.push(t('top.ccrCurrent'))
  if (slot.until * 1000 > now) lines.push(t('top.ccrSpent', { reset: resetText(slot.until, now) }))
  lines.push(t('top.ccrUsage', { five: pct(usage.five), week: pct(usage.week) }))
  lines.push(usage.live ? t('top.ccrLive') : slot.measuredAt ? t('top.ccrMeasured', { time: time(slot.measuredAt) }) : t('top.ccrUnmeasured'))
  if (slot.measureError) lines.push(t('top.ccrFailed', { error: slot.measureError }))
  const token = slotToken(slot, now)
  if (token.kind === 'year') lines.push(t('top.ccrTokenTitle'))
  else if (token.kind === 'days') lines.push(t('top.ccrRefreshTitle', { n: token.days }))
  else if (token.kind === 'expired') lines.push(t('top.ccrExpiredTitle'))
  return lines.join('\n')
}

function MiniMeter({ label, percent }: { label: string; percent: number | undefined }) {
  const level = percent === undefined ? '' : percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'good'
  // An unmeasured slot is dimmed so it cannot be read as 0%.
  return (
    <span className={`ccr-meter ${percent === undefined ? 'unmeasured' : ''}`}>
      <span className="ccr-label">{label}</span>
      <span className="meter-track">
        {percent !== undefined && <span className={`meter-fill ${level}`} style={{ width: `${Math.min(100, percent)}%` }} />}
      </span>
      <span className="ccr-pct">{percent === undefined ? '-' : `${Math.round(percent)}%`}</span>
    </span>
  )
}

function TokenBadge({ slot }: { slot: CcrSlot }) {
  const token = slotToken(slot)
  if (token.kind === 'none') return null
  if (token.kind === 'year')
    return (
      <Badge mono tone="good" className="ccr-token">
        {t('top.ccrToken')}
      </Badge>
    )
  if (token.kind === 'expired')
    return (
      <Badge mono tone="bad" className="ccr-token">
        {t('top.ccrExpired')}
      </Badge>
    )
  return <Badge mono tone={token.warn ? 'bad' : 'neutral'} className="ccr-token">{`D-${token.days}`}</Badge>
}

function CcrSlots({ ccr, sessions, onMeasure, measuring }: { ccr: NonNullable<AccountInfo['ccr']>; sessions: BridgeState['sessions']; onMeasure: () => void; measuring: boolean }) {
  return (
    <span className={`ccr-slots ${measuring ? 'measuring' : ''}`}>
      {ccr.slots.map(slot => {
        const usage = slotUsage(slot, sessions)
        const state = !signedIn(slot) ? 'off' : !ccrFree(slot) ? 'spent' : ''
        // ccr moves a spent or signed out slot to the next free one, so only a free slot can be opened as asked.
        const runnable = ccrFree(slot)
        return (
          <span key={slot.slot} className={`ccr-slot ${state} ${slot.slot === ccr.current ? 'current' : ''}`}>
            <button className="ccr-measure" title={`${t('top.ccrTitle')}\n\n${slotTitle(slot, slot.slot === ccr.current, usage)}`} onClick={onMeasure}>
              <b>{slot.slot}</b>
              <MiniMeter label={t('top.ccrFive')} percent={usage.five} />
              <MiniMeter label={t('top.ccrWeek')} percent={usage.week} />
              <TokenBadge slot={slot} />
            </button>
            <IconButton
              icon="play"
              size="sm"
              className="ccr-run"
              disabled={!runnable}
              label={t('top.ccrRun')}
              title={runnable ? t('top.ccrRun') : !signedIn(slot) ? t('top.ccrRunOff') : t('top.ccrRunSpent')}
              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CLAUDE_SLOT, { detail: slot.slot }))}
            />
          </span>
        )
      })}
    </span>
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
  wait,
  waitScoped = null,
  onOpenUpdate,
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
  // The one "waiting for me" count (waiting.ts), for everything and for the project in view.
  wait: WaitCount
  waitScoped?: WaitCount | null
  onOpenUpdate?: () => void
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
  const running = runningOf(state)
  const scopedRunning = scoped ? runningOf(scoped) : null
  // A count of nothing says nothing: the agents and waiting chips show once there is one.
  const showAgents = running > 0 || (scopedRunning ?? 0) > 0
  const showWait = wait.total > 0 || (waitScoped?.total ?? 0) > 0
  const waitHere = waitScoped ?? wait
  const theme = themeOf(state.settings.theme)
  const light = isLight(theme)

  const flip = async () => {
    const next = flipTheme(theme, typeof state.settings.darkTheme === 'string' ? state.settings.darkTheme : undefined, DEFAULT_THEME)
    if (!light) await saveSetting('darkTheme', next.lastDark)
    await saveSetting('theme', next.theme)
  }

  // Three groups: who and how much (left, drops items as the window narrows), find (center),
  // what needs you and the view controls (right, always shown).
  return (
    <header className="topbar">
      <div className="topbar-group topbar-left" role="group" aria-label={t('top.groupAccount')}>
        <span className="brand">
          <BrandMark />
          Switchboard
        </span>
        {/* Low priority first to go: a narrow window drops these (styles.css, top bar) before anything on the right. */}
        <div className="topbar-info">
          {ccr ? (
            <CcrSlots ccr={ccr} sessions={state.sessions} onMeasure={measure} measuring={measuring} />
          ) : (
            account && (
              <span className="account" title={t('top.accountTitle', { email: account.email })}>
                <span className="quiet small account-email">{account.email}</span>
                {account.plan && <Badge shape="pill">{account.plan}</Badge>}
              </span>
            )
          )}
          {usage.model && (
            <Badge shape="pill" className="topbar-model">
              {usage.model}
            </Badge>
          )}
          {/* With ccr the slots above already carry each account's limits. */}
          {!ccr && <Meter label={t('top.fiveHour')} percent={five?.percentUsed} reset={resetText(five?.resetsAt)} />}
          {!ccr && <Meter label={t('top.week')} percent={week?.percentUsed} reset={resetText(week?.resetsAt)} />}
          <Meter label={t('top.context')} percent={usage.contextPercent} />
          {cost !== undefined && <span className="quiet small topbar-cost">{t('top.cost', { cost: `$${cost.toFixed(2)}` })}</span>}
          <Chip className="topbar-report" onClick={onReport} title={t('top.reportTitle')}>
            {t('top.report')}
          </Chip>
        </div>
      </div>
      <span className="spacer" />
      <button type="button" className="searchbox" onClick={onSearch}>
        <Icon name="search" size="sm" /> {t('top.search')} <kbd>{SEARCH_KEY}</kbd>
      </button>
      <span className="spacer" />
      <div className="topbar-group topbar-right" role="group" aria-label={t('top.groupStatus')}>
        {showWait && (
          <Chip tone={waitHere.total > 0 ? 'warn' : 'neutral'} className="wait-chip" title={[t('wait.chipTitle'), waitParts(waitHere)].filter(Boolean).join('\n')} onClick={onQuestions}>
            {countLabel(t('wait.label'), wait.total, waitScoped ? waitScoped.total : null)}
          </Chip>
        )}
        {showAgents && (
          <Badge shape="pill" tone={(scopedRunning ?? running) > 0 ? 'accent' : 'neutral'}>
            {countLabel(t('top.agents'), running, scopedRunning)}
          </Badge>
        )}
        {onOpenUpdate && <UpdateChip onOpen={onOpenUpdate} />}
        {/* One badge for both facts: a dropped bridge outranks the live toggle, since paused or live means nothing without a link. */}
        {onToggleLive ? (
          <Chip
            tone={!connected ? 'bad' : live ? 'good' : 'warn'}
            className="live"
            title={!connected ? t('top.disconnectedTitle') : live ? t('top.liveOnTitle') : t('top.liveOffTitle')}
            onClick={connected ? onToggleLive : undefined}
          >
            {!connected ? t('top.disconnected') : live ? t('top.live') : t('top.paused')}
          </Chip>
        ) : (
          <Badge shape="pill" tone={connected ? 'good' : 'bad'}>
            {connected ? t('top.connected') : t('top.disconnected')}
          </Badge>
        )}
        <span className="topbar-sep" aria-hidden="true" />
        <span className="topbar-actions">
          {onToggleSidebar && <IconButton icon="sidebar" label={t('top.toggleSidebar')} onClick={onToggleSidebar} />}
          {onToggleDock && <IconButton icon="dock" label={t('top.toggleDock')} onClick={onToggleDock} />}
          <IconButton icon={light ? 'moon' : 'sun'} label={light ? t('top.toDark') : t('top.toLight')} onClick={() => void flip()} />
        </span>
      </div>
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
