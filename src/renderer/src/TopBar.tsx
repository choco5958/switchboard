import { useEffect, useRef, useState } from 'react'
import type { AccountInfo, BridgeState, CcrSlot, SessionUsage } from '../../shared/types'
import { OPEN_CLAUDE_SLOT, refreshDaysLeft } from '../../shared/ccr'
import { flipTheme, isLight, resetText } from './taskInfo'
import { DEFAULT_THEME, themeOf } from './theme'
import { isClaude } from '../../shared/agents'
import { LOCALE_TAG, getLang, t } from '../../shared/i18n'
import { saveSetting } from './settings'
import { Badge, Chip, IconButton } from './ui'
import { UpdateChip } from './flows'

// The usage meters: Claude Code's from the mod; Codex's from its MCP server (mcp/codexUsage.ts),
// shown on their own. Other agent CLIs report none.
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

// Codex's plan usage, from the Codex session that reported last; {} when none did lately.
export function codexUsageOf(state: BridgeState, now = Date.now()): SessionUsage {
  let best: SessionUsage = {}
  let at = 0
  for (const session of state.sessions) {
    if (session.agent !== 'codex' || now - session.last_seen > LIVE_MS || session.last_seen <= at) continue
    try {
      const usage = JSON.parse(session.usage || '{}') as SessionUsage
      if (!usage.rateLimits?.length) continue
      best = usage
      at = session.last_seen
    } catch {
      // a session that never reported usage
    }
  }
  return best
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

// The bottom of the sidebar: how much of the Claude limits is used (the account panel opens
// above it with the account, ccr slots, context, cost and the report button), the link to the
// bridge with the live toggle, a ready update, and the light and dark switch.
export function StatusFooter({
  state,
  connected,
  live = true,
  onToggleLive,
  onReport,
  onOpenUpdate,
  onSettings,
}: {
  state: BridgeState
  connected: boolean
  live?: boolean
  onToggleLive: () => void
  onReport: () => void
  onOpenUpdate: () => void
  onSettings: () => void
}) {
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [panel, setPanel] = useState(false)
  const box = useRef<HTMLDivElement>(null)
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
  // The panel closes on a press outside it or on Esc.
  useEffect(() => {
    if (!panel) return
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setPanel(false)
    }
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setPanel(false)
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc)
    }
  }, [panel])
  const ccr = account?.ccr
  const usage = usageOf(state)
  const five = usage.rateLimits?.find(r => r.kind === 'five_hour')
  const week = usage.rateLimits?.find(r => r.kind === 'seven_day')
  const cost = usage.cost?.totalUsd
  const codex = codexUsageOf(state).rateLimits ?? []
  const codexFive = codex.find(r => r.kind === 'five_hour')
  const codexWeek = codex.find(r => r.kind === 'seven_day')
  const theme = themeOf(state.settings.theme)
  const light = isLight(theme)
  const flip = async () => {
    const next = flipTheme(theme, typeof state.settings.darkTheme === 'string' ? state.settings.darkTheme : undefined, DEFAULT_THEME)
    if (!light) await saveSetting('darkTheme', next.lastDark)
    await saveSetting('theme', next.theme)
  }
  const pct = (n: number | undefined) => (n === undefined ? '-' : `${Math.round(n)}%`)
  const summary =
    five || week
      ? t('foot.usage', { five: pct(five?.percentUsed), week: pct(week?.percentUsed) })
      : ccr
        ? t('foot.ccr', { n: ccr.slots.length })
        : (account?.plan ?? t('foot.account'))

  return (
    <div className="status-footer" ref={box}>
      {panel && (
        <div className="account-panel" role="dialog" aria-label={t('top.groupAccount')}>
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
          {usage.model && <span className="quiet small">{usage.model}</span>}
          {!ccr && <Meter label={t('top.fiveHour')} percent={five?.percentUsed} reset={resetText(five?.resetsAt)} />}
          {!ccr && <Meter label={t('top.week')} percent={week?.percentUsed} reset={resetText(week?.resetsAt)} />}
          <Meter label={t('top.context')} percent={usage.contextPercent} />
          {(codexFive || codexWeek) && <span className="quiet small">Codex</span>}
          {codexFive && <Meter label={t('top.fiveHour')} percent={codexFive.percentUsed} reset={resetText(codexFive.resetsAt)} />}
          {codexWeek && <Meter label={t('top.week')} percent={codexWeek.percentUsed} reset={resetText(codexWeek.resetsAt)} />}
          {cost !== undefined && <span className="quiet small">{t('top.cost', { cost: `$${cost.toFixed(2)}` })}</span>}
          <Chip onClick={onReport} title={t('top.reportTitle')}>
            {t('top.report')}
          </Chip>
        </div>
      )}
      <button type="button" className="foot-usage" aria-expanded={panel} title={[five && resetText(five.resetsAt), week && resetText(week.resetsAt)].filter(Boolean).join('\n') || undefined} onClick={() => setPanel(open => !open)}>
        {summary}
      </button>
      <div className="foot-line">
        <button
          type="button"
          className={`foot-live ${!connected ? 'bad' : live ? 'good' : 'warn'}`}
          title={!connected ? t('top.disconnectedTitle') : live ? t('top.liveOnTitle') : t('top.liveOffTitle')}
          onClick={connected ? onToggleLive : undefined}
        >
          {!connected ? t('top.disconnected') : live ? t('top.live') : t('top.paused')}
        </button>
        <UpdateChip onOpen={onOpenUpdate} />
        <span className="spacer" />
        <IconButton icon={light ? 'moon' : 'sun'} size="sm" label={light ? t('top.toDark') : t('top.toLight')} onClick={() => void flip()} />
        <IconButton icon="settings" size="sm" label={t('rail.settings')} onClick={onSettings} />
      </div>
    </div>
  )
}

// The plug board of the app icon (scripts/icon.mjs): four jacks, one lit in the theme's accent.
export function BrandMark() {
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
