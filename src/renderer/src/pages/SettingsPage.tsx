import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_THEME, THEMES, applyTheme, themeLabel, themeOf } from '../theme'
import { LANGS, isLang, resolveLang, t, type Key, type Lang } from '../../../shared/i18n'
import { useToast } from '../parts'
import { AgentSettings } from './AgentSettings'
import { AccountsSection } from './AccountsSection'
import { RoutinesSection } from './RoutinesSection'
import { TelegramSection } from './TelegramSection'
import { MobileSection } from './MobileSection'
import { UpdateSection } from './UpdateSection'
import type { Routine, RoutineRun } from '../../../shared/types'
import type { ProjectInfo } from '../../../shared/projects'
import { saveSetting } from '../settings'
import { CUSTOM_AGENTS_KEY, customAgents } from '../../../shared/agents'
import { DECISION_KEYS_KEY } from '../QuestionCard'
import { Button, More, SettingRow, Switch, cx, surfaceClass } from '../ui'
import { Icon } from '../Icons'

// The settings screen, laid out as Orca's: a menu of sections in groups (with a search) where the
// sidebar was, and the one section picked beside it, its title and what it is for above its rows.
export type SettingsSection = { id: string; title: Key; hint?: Key; more?: Key; words: Key[] }
export type SettingsGroup = { title: Key; sections: SettingsSection[] }

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: 'settings.groupAnswer',
    sections: [
      { id: 'settings-telegram', title: 'telegram.title', hint: 'telegram.hint', more: 'telegram.hintMore', words: ['telegram.connectBot', 'telegram.getCode'] },
      { id: 'settings-mobile', title: 'mobile.title', hint: 'mobile.hint', more: 'mobile.hintMore', words: ['mobile.enable', 'mobile.recommended'] },
    ],
  },
  {
    title: 'settings.groupAgents',
    sections: [
      { id: 'settings-agents', title: 'agents.title', hint: 'agents.intro', more: 'agents.introMore', words: ['agents.showOthers', 'agents.closeOnQuit', 'agents.secCli', 'agents.customTitle', 'agents.secAdd'] },
      { id: 'settings-accounts', title: 'accounts.title', hint: 'accounts.intro', more: 'accounts.introMore', words: ['accounts.add', 'accounts.active', 'accounts.login', 'accounts.default'] },
      { id: 'settings-safety', title: 'settings.safety', hint: 'settings.safetyHint', words: ['agents.trustFolders', 'agents.codexApprovals', 'agents.geminiExtension', 'agents.browserLan'] },
      { id: 'settings-routines', title: 'routines.title', hint: 'routines.hint', more: 'routines.hintMore', words: [] },
    ],
  },
  {
    title: 'settings.groupLook',
    sections: [
      { id: 'settings-theme', title: 'settings.theme', hint: 'settings.themeHint', words: ['settings.defaultTheme'] },
      { id: 'settings-lang', title: 'settings.language', hint: 'settings.languageHint', words: ['settings.languageSystem'] },
      { id: 'settings-keys', title: 'settings.keys', hint: 'settings.keysHint', words: ['settings.decisionKeysAnywhere'] },
    ],
  },
  {
    title: 'settings.groupApp',
    sections: [
      { id: 'settings-update', title: 'updates.title', hint: 'settings.updateHint', words: [] },
      { id: 'settings-dev', title: 'settings.dev', hint: 'settings.devHint', words: ['settings.devMenu'] },
    ],
  },
]

export const FIRST_SECTION = 'settings-telegram'
const ALL = SETTINGS_GROUPS.flatMap(group => group.sections)

// A section that matches every word of the query in its title, its line or the names of its rows.
export function sectionMatches(section: SettingsSection, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [section.title, section.hint, ...section.words]
    .filter((key): key is Key => !!key)
    .map(key => t(key))
    .join(' ')
    .toLowerCase()
  return words.every(word => text.includes(word))
}

// The section a link names, or the first; a name from before the safety section had its own page
// still lands where its rows are.
export function sectionOf(id: string | undefined): string {
  return ALL.some(s => s.id === id) ? id! : FIRST_SECTION
}

export function SettingsNav({ current, onPick, onBack }: { current: string; onPick: (id: string) => void; onBack: () => void }) {
  const [query, setQuery] = useState('')
  const groups = useMemo(
    () => SETTINGS_GROUPS.map(group => ({ ...group, sections: group.sections.filter(s => sectionMatches(s, query)) })).filter(group => group.sections.length > 0),
    [query],
  )
  // A search that leaves the open section out moves to the first one it found.
  useEffect(() => {
    const found = groups.flatMap(group => group.sections)
    if (found.length > 0 && !found.some(s => s.id === current)) onPick(found[0]!.id)
  }, [groups, current, onPick])
  return (
    <aside className="sidebar settings-nav" aria-label={t('rail.settings')}>
      <div className="settings-nav-head">
        <Button variant="ghost" size="sm" className="settings-back" onClick={onBack}>
          <Icon name="collapse" size="sm" /> {t('settings.back')}
        </Button>
        <label className="settings-search">
          <Icon name="search" size="sm" />
          <input type="search" value={query} placeholder={t('settings.search')} aria-label={t('settings.search')} onChange={e => setQuery(e.target.value)} />
        </label>
      </div>
      <nav className="settings-nav-list">
        {groups.length === 0 && <p className="quiet small settings-nav-empty">{t('settings.noMatch')}</p>}
        {groups.map(group => (
          <div key={group.title} className="settings-nav-group">
            <h2 className="settings-nav-title">{t(group.title)}</h2>
            {group.sections.map(section => (
              <button
                key={section.id}
                type="button"
                className={cx('side-item', section.id === current && 'on')}
                aria-current={section.id === current ? 'page' : undefined}
                onClick={() => onPick(section.id)}
              >
                <span className="side-label">{t(section.title)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  )
}

// Tokens shown in each theme's swatch strip. The strip carries data-theme, so it shows that theme's own colors.
const SWATCH = ['--bg', '--panel', '--line', '--text', '--accent', '--good', '--warn', '--bad']

// The gallery is a rail tab; pressing its rail button opens it without reaching into App.
function openGallery() {
  document.querySelector<HTMLButtonElement>('.rail-button[data-rail="gallery"]')?.click()
}

// A section's frame: its title and what it is for, then its rows. `bands`: the body is already
// in bands of its own (SettingGroup), else it goes in one.
function Frame({ section, bands, children }: { section: SettingsSection; bands?: boolean; children: ReactNode }) {
  return (
    <section id={section.id} className="settings-pane">
      <header className="settings-pane-head">
        <h1>{t(section.title)}</h1>
        {section.hint && (
          <p>
            {t(section.hint)}
            {section.more && <More>{t(section.more)}</More>}
          </p>
        )}
      </header>
      {bands ? children : <div className="setting-band">{children}</div>}
    </section>
  )
}

export function SettingsPage({
  section = FIRST_SECTION,
  settings = {},
  routines = [],
  runs = [],
  projects = [],
}: {
  section?: string
  settings?: Record<string, unknown>
  routines?: Routine[]
  runs?: RoutineRun[]
  projects?: ProjectInfo[]
}) {
  const toast = useToast()
  const devMenu = settings.devMenu === true
  const saved = themeOf(settings.theme)
  const [chosen, setChosen] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const current = chosen ?? saved
  // The pick shows at once; once the saved theme is the same, the saved one rules again, so a
  // theme changed elsewhere (the top bar's light and dark button) shows here too.
  useEffect(() => {
    if (chosen !== null && chosen === saved) setChosen(null)
  }, [chosen, saved])
  const isDefault = settings.theme === undefined && current === DEFAULT_THEME

  const save = async (value: string | null) => {
    const next = themeOf(value)
    setChosen(next)
    applyTheme(next)
    setStatus('saving')
    setError('')
    const reply = await saveSetting('theme', value)
    if (reply.ok) return setStatus('saved')
    setChosen(null)
    applyTheme(saved)
    setStatus('idle')
    setError(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }))
  }

  // Feature area: UI language. The app redraws as soon as the bridge reports the new setting.
  const lang = resolveLang(settings.lang, navigator.language)
  const langSet = isLang(settings.lang)
  const saveLang = async (value: Lang | null) => {
    const reply = await saveSetting('lang', value)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The component gallery in the rail is for building the IDE itself; off unless asked for.
  const toggleDevMenu = async () => {
    const reply = await saveSetting('devMenu', devMenu ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The decision card's single-letter keys: only while the card has focus (the default), or anywhere.
  const keysAnywhere = settings[DECISION_KEYS_KEY] === true
  const toggleKeys = async () => {
    const reply = await saveSetting(DECISION_KEYS_KEY, keysAnywhere ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  const shown = ALL.find(s => s.id === sectionOf(section))!
  const body = (): ReactNode => {
    switch (shown.id) {
      case 'settings-telegram':
        return <TelegramSection />
      case 'settings-mobile':
        return <MobileSection />
      case 'settings-routines':
        return <RoutinesSection routines={routines} runs={runs} projects={projects} customs={customAgents(settings[CUSTOM_AGENTS_KEY])} />
      case 'settings-update':
        return <UpdateSection />
      case 'settings-keys':
        return (
          <SettingRow title={t('settings.decisionKeysAnywhere')} hint={t('settings.decisionKeysAnywhereHint')}>
            <Switch checked={keysAnywhere} onChange={() => void toggleKeys()} label={t('settings.decisionKeysAnywhere')} />
          </SettingRow>
        )
      case 'settings-dev':
        return (
          <SettingRow title={t('settings.devMenu')} hint={t('settings.devMenuHint')}>
            <Switch checked={devMenu} onChange={() => void toggleDevMenu()} label={t('settings.devMenu')} />
          </SettingRow>
        )
      case 'settings-lang':
        return (
          <>
            <div className="lang-list" role="radiogroup" aria-label={t('settings.language')}>
              {LANGS.map(one => (
                <button
                  key={one.id}
                  type="button"
                  role="radio"
                  lang={one.id}
                  className={surfaceClass({ on: one.id === lang }, 'lang-option')}
                  aria-checked={one.id === lang}
                  onClick={() => void saveLang(one.id)}
                >
                  {one.label}
                </button>
              ))}
            </div>
            <p className="quiet small">
              {langSet ? (
                <Button variant="link" size="sm" className="inline-link" onClick={() => void saveLang(null)}>
                  {t('settings.languageSystem')}
                </Button>
              ) : (
                t('settings.languageFollowing')
              )}
            </p>
          </>
        )
      case 'settings-theme':
        return (
          <>
            <div className="theme-list">
              {THEMES.map(theme => (
                <button
                  key={theme.id}
                  type="button"
                  className={surfaceClass({ on: theme.id === current }, 'theme-option')}
                  aria-pressed={theme.id === current}
                  disabled={status === 'saving'}
                  onClick={() => void save(theme.id)}
                >
                  <span className="swatch" data-theme={theme.id}>
                    {SWATCH.map(token => (
                      <i key={token} style={{ background: `var(${token})` }} />
                    ))}
                  </span>
                  <span className="theme-label">
                    {themeLabel(theme)} <span className="quiet small mono-inline">({theme.id})</span>
                  </span>
                  {theme.id === current && <span className="quiet small">{t('settings.inUse')}</span>}
                </button>
              ))}
            </div>
            {(devMenu || import.meta.env.DEV) && (
              <p className="quiet small">
                <Button variant="link" size="sm" className="inline-link" onClick={openGallery}>
                  {t('settings.galleryLink')}
                </Button>
              </p>
            )}
            <div className="actions">
              <Button disabled={status === 'saving' || isDefault} onClick={() => void save(null)}>
                {t('settings.defaultTheme')}
              </Button>
              {status === 'saving' && <span className="quiet small">{t('settings.saving')}</span>}
              {status === 'saved' && <span className="answered small">{t('settings.saved')}</span>}
              {error && <span className="error small">{error}</span>}
            </div>
          </>
        )
      default:
        return null
    }
  }

  if (shown.id === 'settings-accounts')
    return (
      <div className="settings-screen">
        <Frame section={shown} bands>
          <AccountsSection />
        </Frame>
      </div>
    )
  if (shown.id === 'settings-agents' || shown.id === 'settings-safety')
    return (
      <div className="settings-screen">
        <Frame section={shown} bands>
          <AgentSettings settings={settings} part={shown.id === 'settings-safety' ? 'safety' : 'cli'} />
        </Frame>
      </div>
    )
  return (
    <div className="settings-screen">
      <Frame section={shown}>{body()}</Frame>
    </div>
  )
}

