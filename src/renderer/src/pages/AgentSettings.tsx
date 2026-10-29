import { useEffect, useState } from 'react'
import type { AgentDetect } from '../../../shared/types'
import { CUSTOM_AGENTS_KEY, PLACEHOLDERS, PRESETS, SHOW_OTHER_AGENTS_KEY, customAgents, showOtherAgents, validateCustom } from '../../../shared/agents'
import { AGENTS_FOUND } from '../Dock'
import { useToast } from '../parts'
import { t } from '../../../shared/i18n'
import { tx } from '../tx'

// Settings for agent CLIs other than Claude Code: which presets are installed, and
// the person's own entries. Saving an entry runs nothing; its dock button does.
export function AgentSettings({ settings }: { settings: Record<string, unknown> }) {
  const toast = useToast()
  const customs = customAgents(settings[CUSTOM_AGENTS_KEY])
  const showOthers = showOtherAgents(settings[SHOW_OTHER_AGENTS_KEY])
  const [found, setFound] = useState<AgentDetect | null>(null)
  const [looking, setLooking] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', mcp: '' })
  const [error, setError] = useState('')

  const look = async (force: boolean) => {
    setLooking(true)
    const result = await window.ide.detectAgents(force)
    setLooking(false)
    setFound(result)
    window.dispatchEvent(new CustomEvent(AGENTS_FOUND, { detail: result }))
  }

  useEffect(() => {
    void look(false)
  }, [])

  const save = async (list: typeof customs) => {
    const reply = await window.ide.bridge('POST', '/settings', { key: CUSTOM_AGENTS_KEY, value: list.length > 0 ? list : null })
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
    return reply.ok
  }

  const toggleOthers = async () => {
    const reply = await window.ide.bridge('POST', '/settings', { key: SHOW_OTHER_AGENTS_KEY, value: showOthers ? false : null })
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  const add = async () => {
    const checked = validateCustom(form, customs)
    if ('error' in checked) return setError(checked.error)
    setError('')
    if (await save([...customs, checked.entry])) {
      setForm({ name: '', command: '', mcp: '' })
      toast(t('agents.added', { name: checked.entry.name }))
    }
  }

  return (
    <section id="settings-agents" className="settings-row agent-settings">
      <h2>{t('agents.title')}</h2>
      <p className="quiet small">{t('agents.intro')}</p>
      <label className="check-row">
        <input type="checkbox" checked={showOthers} onChange={() => void toggleOthers()} />
        {t('agents.showOthers')}
        <span className="quiet small">{t('agents.showOthersHint')}</span>
      </label>
      <ul className="agent-list">
        {PRESETS.map(p => {
          const path = found?.found[p.bin]
          return (
            <li key={p.id} className="agent-row">
              <span className="agent-row-name">
                <span className={`agent-badge agent-${p.id}`}>{p.label}</span> <span className="mono-inline small">{p.bin}</span>
              </span>
              {found === null ? (
                <span className="quiet small">{t('agents.looking')}</span>
              ) : path ? (
                <span className="chip chip-good" title={path}>
                  {t('agents.installed')}
                </span>
              ) : (
                <span className="chip">{t('agents.missing')}</span>
              )}
              {p.mcp === null && <span className="chip" title={t(p.how)}>{t('agents.terminalOnly')}</span>}
              <span className="quiet small agent-row-how">{p.mcp ? t('agents.via', { how: t(p.how) }) : t(p.how)}</span>
              {found !== null && !path && (
                <span className="small agent-row-install">{tx('agents.installHint', { command: <code>{p.install}</code> })}</span>
              )}
              <a className="small" href={p.docs} target="_blank" rel="noreferrer">
                {t('agents.docs')}
              </a>
            </li>
          )
        })}
      </ul>
      <p className="quiet small">
        <button className="link small inline-link" disabled={looking} onClick={() => void look(true)}>
          {looking ? t('agents.looking') : t('agents.lookAgain')}
        </button>{' '}
        {t('agents.lookNote')}
      </p>

      <h3>{t('agents.customTitle')}</h3>
      {customs.length === 0 && <p className="quiet small">{t('agents.customNone')}</p>}
      <ul className="agent-list">
        {customs.map(c => (
          <li key={c.id} className="agent-row">
            <span className="agent-row-name">
              <span className="agent-badge">{c.name}</span> <span className="mono-inline small">{c.command}</span>
            </span>
            <span className="quiet small agent-row-how">{c.mcp === 'none' ? t('agents.customPlain') : t('agents.via', { how: c.mcp })}</span>
            <button className="link small" onClick={() => void save(customs.filter(o => o.id !== c.id))}>
              {t('agents.remove')}
            </button>
          </li>
        ))}
      </ul>
      <div className="agent-form">
        <label>
          <span className="small">{t('agents.name')}</span>
          <input className="filter" placeholder={t('agents.namePlaceholder')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          <span className="small">{t('agents.command')}</span>
          <input
            className="filter mono-inline"
            placeholder={t('agents.commandPlaceholder')}
            value={form.command}
            onChange={e => setForm({ ...form, command: e.target.value })}
          />
        </label>
        <label>
          <span className="small">{t('agents.mcp')}</span>
          <input
            className="filter mono-inline"
            placeholder={t('agents.mcpPlaceholder', { example: '{server}' })}
            value={form.mcp}
            onChange={e => setForm({ ...form, mcp: e.target.value })}
          />
        </label>
        <p className="quiet small">
          {t('agents.mcpHelp', { list: PLACEHOLDERS.map(p => `{${p}}`).join(', '), file: '{config_file}' })}
        </p>
        <p className="quiet small">{t('agents.llama', { example: '{server}' })}</p>
        {error && <p className="error small">{error}</p>}
        <div className="actions">
          <button disabled={!form.name.trim() || !form.command.trim()} onClick={() => void add()}>
            {t('agents.add')}
          </button>
          <span className="quiet small">{t('agents.addNote')}</span>
        </div>
      </div>
    </section>
  )
}
