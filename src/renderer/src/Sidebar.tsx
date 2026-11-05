import { useRef, useState, type ReactNode } from 'react'
import type { ProjectFolder, ProjectInfo } from '../../shared/projects'
import { agentLabel, type CustomAgent } from '../../shared/agents'
import { t, type Key } from '../../shared/i18n'
import type { AgentChoice } from './Dock'
import { Icon, type IconName } from './Icons'
import { ProjectList } from './ProjectList'
import { needsAnswer, rowsByProject, type RowState, type SessionRow } from './sessions'
import { BrandMark } from './TopBar'
import { IconButton, Menu, MenuItem, MenuSeparator, cx } from './ui'

// The one sidebar: home with what waits for the person, find, every project with its sessions
// under it, the other screens, and the status footer. Picking a session row opens it in the
// main area (SessionView); `+` beside a project opens a new session there.

// The search key as this system writes it (App.tsx takes both).
const SEARCH_KEY = /Mac/.test(navigator.userAgent) ? '⌘K' : 'Ctrl+K'

const STATE_WORD: Record<RowState, Key | null> = {
  question: 'row.question',
  approval: 'row.approval',
  stalled: 'row.stalled',
  limited: 'row.limited',
  offline: 'row.offline',
  working: 'row.working',
  idle: null,
  ended: 'row.ended',
}

// The agent under a row's name, unless the name already says it (a plain shell is called the shell).
export function rowAgent(row: SessionRow, customs: readonly CustomAgent[]): string {
  const label = row.agent === 'shell' ? t('row.shell') : agentLabel(row.agent, customs)
  return label === row.title || label.toLowerCase() === row.title.toLowerCase() ? '' : label
}

export function rowStateText(row: SessionRow): string {
  if (row.state === 'question' && row.questions.length > 1) return t('row.questions', { n: row.questions.length })
  const word = STATE_WORD[row.state]
  return word ? t(word) : ''
}

export type NavItem = { icon: IconName; label: string; key: string; onOpen: () => void }

export function Sidebar({
  rows,
  projects,
  hidden,
  hiddenPending,
  folders,
  customs,
  choices,
  active,
  waiting,
  nav,
  footer,
  hiddenForSettings = false,
  onHome,
  onSearch,
  onOpenRow,
  onLaunch,
  onAddProject,
  update,
}: {
  rows: SessionRow[]
  projects: ProjectInfo[]
  hidden: string[]
  hiddenPending: Record<string, number>
  folders: ProjectFolder[]
  customs: CustomAgent[]
  choices: AgentChoice[] // what `+` beside a project can open (Dock.tsx agentChoices)
  active: string // the key of what the main area shows: 'home', a row key, or a screen's
  waiting: number // everything that waits for the person (waiting.ts)
  nav: NavItem[]
  footer: ReactNode
  // The settings screen puts its own menu here (SettingsNav); the sidebar stays mounted, folds and all.
  hiddenForSettings?: boolean
  onHome: () => void
  onSearch: () => void
  onOpenRow: (row: SessionRow) => void
  onLaunch: (cwd: string, choice: { kind: string; warn?: string; blocked?: boolean; title?: string; installed?: boolean }) => void
  onAddProject: () => void
  update: (key: string, change: (current: unknown) => unknown) => void
}) {
  const byProject = rowsByProject(rows)
  // Whose `+` menu is open, and the line it opened from (a press there is not a click outside).
  const [adding, setAdding] = useState<string | null>(null)
  const addLine = useRef<HTMLSpanElement | null>(null)
  const usable = choices.filter(c => c.installed)

  const sessionRow = (row: SessionRow) => (
    <button
      key={row.key}
      type="button"
      className={cx('row session-row', active === row.key && 'on')}
      data-state={row.state}
      aria-current={active === row.key ? 'page' : undefined}
      title={row.cwd}
      onClick={() => onOpenRow(row)}
    >
      <span className="state-dot" aria-hidden="true" />
      <span className="session-text">
        <span className="session-title">{row.title}</span>
        {rowAgent(row, customs) && <span className="session-sub">{rowAgent(row, customs)}</span>}
      </span>
      <span className={cx('session-state', needsAnswer(row.state) && 'strong')}>{rowStateText(row)}</span>
    </button>
  )

  return (
    <aside className="sidebar" hidden={hiddenForSettings}>
      <div className="side-brand">
        <BrandMark />
        <span>Switchboard</span>
      </div>
      <nav className="side-top" aria-label={t('side.main')}>
        <button type="button" className={cx('row side-item', active === 'home' && 'on')} aria-current={active === 'home' ? 'page' : undefined} onClick={onHome}>
          <Icon name="home" size="sm" />
          <span className="side-label">{t('rail.home')}</span>
          {waiting > 0 && <span className="side-count" title={t('side.waitingTitle', { n: waiting })}>{waiting}</span>}
        </button>
        <button type="button" className="row side-item" onClick={onSearch}>
          <Icon name="search" size="sm" />
          <span className="side-label">{t('top.search')}</span>
          <kbd>{SEARCH_KEY}</kbd>
        </button>
      </nav>

      <div className="side-projects">
        <ProjectList
          projects={projects}
          hidden={hidden}
          hiddenPending={hiddenPending}
          folders={folders}
          onAddProject={onAddProject}
          update={update}
          renderRows={p => {
            const list = byProject.get(p.name) ?? []
            return list.length > 0 ? list.map(sessionRow) : <p className="quiet small side-empty">{t('side.noSessions')}</p>
          }}
          renderAdd={p => (
            <span className="add-line" ref={adding === p.name ? addLine : undefined}>
              <IconButton
                icon="plus"
                size="sm"
                className="row-more"
                label={t('side.newSession', { project: p.name })}
                aria-haspopup="menu"
                aria-expanded={adding === p.name}
                onClick={() => setAdding(adding === p.name ? null : p.name)}
              />
              {adding === p.name && (
                <Menu label={t('side.newSession', { project: p.name })} className="row-menu new-session-menu" within={addLine} onClose={() => setAdding(null)}>
                  {usable.map(c => (
                    <MenuItem key={c.kind} title={c.title} className={c.warn ? 'add-warn' : undefined} onSelect={() => onLaunch(p.cwd, c)}>
                      <span className="dock-menu-name">{c.label}</span>
                      <span className="spacer" />
                      <span className="quiet small">{t(`dock.via.${c.via}`)}</span>
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem onSelect={() => onLaunch(p.cwd, { kind: 'shell' })}>{t('row.newShell')}</MenuItem>
                </Menu>
              )}
            </span>
          )}
        />
      </div>

      <nav className="side-nav" aria-label={t('side.screens')}>
        {nav.map(item => (
          <button key={item.key} type="button" className={cx('row side-item', active === item.key && 'on')} aria-current={active === item.key ? 'page' : undefined} onClick={item.onOpen}>
            <Icon name={item.icon} size="sm" />
            <span className="side-label">{item.label}</span>
          </button>
        ))}
      </nav>
      {footer}
    </aside>
  )
}
