import { useEffect, useState } from 'react'
import type { AccountInfo, BridgeState, SessionUsage } from '../../shared/types'
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
  useEffect(() => {
    void window.ide.accountInfo?.().then(setAccount)
  }, [])
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
      {account && (
        <span className="account" title={t('top.accountTitle', { email: account.email })}>
          <span className="quiet small account-email">{account.email}</span>
          {account.plan && <span className="chip">{account.plan}</span>}
        </span>
      )}
      {usage.model && <span className="chip topbar-model">{usage.model}</span>}
      <Meter label={t('top.fiveHour')} percent={five?.percentUsed} reset={resetText(five?.resetsAt)} />
      <Meter label={t('top.week')} percent={week?.percentUsed} reset={resetText(week?.resetsAt)} />
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
