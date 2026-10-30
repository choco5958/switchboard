import { useEffect, useState } from 'react'
import type { AgentDetect } from '../../../shared/types'
import { CLOSE_TERMINALS_KEY, CUSTOM_AGENTS_KEY, PLACEHOLDERS, PRESETS, SHOW_OTHER_AGENTS_KEY, TRUST_FOLDERS_KEY, customAgents, showOtherAgents, trustFolders, validateCustom } from '../../../shared/agents'
import { AGENTS_FOUND } from '../Dock'
import { agentTone, useToast } from '../parts'
import { Badge, Button, EmptyState, Input, More } from '../ui'
import { t } from '../../../shared/i18n'
import { tx } from '../tx'
import { saveSetting } from '../settings'
import { BROWSER_LAN_KEY } from '../agentBrowser'
import { RiskyConfirm } from '../flows'

// Settings for agent CLIs other than Claude Code: which presets are installed, and
// the person's own entries. Saving an entry runs nothing; its dock button does.
export function AgentSettings({ settings }: { settings: Record<string, unknown> }) {
  const toast = useToast()
  const customs = customAgents(settings[CUSTOM_AGENTS_KEY])
  const showOthers = showOtherAgents(settings[SHOW_OTHER_AGENTS_KEY])
  const trusting = trustFolders(settings[TRUST_FOLDERS_KEY])
  const closeOnQuit = settings[CLOSE_TERMINALS_KEY] === true
  const browserLan = settings[BROWSER_LAN_KEY] === true
  // null until known: where no terminal host runs (Windows), terminals always close with the app.
  const [keeps, setKeeps] = useState<boolean | null>(null)
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
    void window.ide.termKeeps().then(setKeeps, () => setKeeps(false))
  }, [])

  const save = async (list: typeof customs) => {
    const reply = await saveSetting(CUSTOM_AGENTS_KEY, list.length > 0 ? list : null)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
    return reply.ok
  }

  const toggleOthers = async () => {
    const reply = await saveSetting(SHOW_OTHER_AGENTS_KEY, showOthers ? false : null)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The two settings that let sessions reach past the default (a folder's own MCP servers and
  // hooks, the local network) turn on only through a second step (flows.tsx RiskyConfirm); off is one click.
  const [confirming, setConfirming] = useState<'trust' | 'lan' | null>(null)
  const toggleTrust = async (confirmed = false) => {
    if (!trusting && !confirmed) return setConfirming('trust')
    const reply = await saveSetting(TRUST_FOLDERS_KEY, trusting ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  const toggleBrowserLan = async (confirmed = false) => {
    if (!browserLan && !confirmed) return setConfirming('lan')
    const reply = await saveSetting(BROWSER_LAN_KEY, browserLan ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  const toggleCloseOnQuit = async () => {
    const reply = await saveSetting(CLOSE_TERMINALS_KEY, closeOnQuit ? null : true)
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
      <p className="quiet small">
        {t('agents.intro')}
        <More>{t('agents.introMore')}</More>
      </p>

      {/* A long section: four parts with their own headings, the switches first. */}
      <h3 className="settings-sub">{t('agents.secDock')}</h3>
      <label className="check-row">
        <input type="checkbox" checked={showOthers} onChange={() => void toggleOthers()} />
        {t('agents.showOthers')}
        <span className="quiet small">{t('agents.showOthersHint')}</span>
      </label>
      {confirming && (
        <RiskyConfirm
          title={t(confirming === 'trust' ? 'agents.trustFolders' : 'agents.browserLan')}
          onClose={() => setConfirming(null)}
          onConfirm={() => void (confirming === 'trust' ? toggleTrust(true) : toggleBrowserLan(true))}
        >
          <p>{t(confirming === 'trust' ? 'risky.trustWhat' : 'risky.lanWhat')}</p>
          <p className="warn-text">{t(confirming === 'trust' ? 'risky.trustRisk' : 'risky.lanRisk')}</p>
          <p className="quiet small">{t('risky.undo')}</p>
        </RiskyConfirm>
      )}
      {keeps === true && (
        <label className="check-row">
          <input type="checkbox" checked={closeOnQuit} onChange={() => void toggleCloseOnQuit()} />
          {t('agents.closeOnQuit')}
          <span className="quiet small">
            {t('agents.closeOnQuitHint')}
            <More>{t('agents.closeOnQuitHintMore')}</More>
          </span>
        </label>
      )}
      {keeps === false && <p className="quiet small">{t('agents.closeOnQuitOff')}</p>}

      <h3 className="settings-sub">{t('agents.secSafety')}</h3>
      <label className="check-row">
        <input type="checkbox" checked={trusting} onChange={() => void toggleTrust()} />
        {t('agents.trustFolders')}
        <span className="quiet small">
          {t('agents.trustFoldersHint')}
          <More>{t('agents.trustFoldersHintMore')}</More>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={browserLan} onChange={() => void toggleBrowserLan()} />
        {t('agents.browserLan')}
        <span className="quiet small">
          {t('agents.browserLanHint')}
          <More>{t('agents.browserLanHintMore')}</More>
        </span>
      </label>

      <h3 className="settings-sub">{t('agents.secCli')}</h3>
      <ul className="agent-list">
        {PRESETS.map(p => {
          const path = found?.found[p.bin]
          return (
            <li key={p.id} className="agent-row">
              <span className="agent-row-name">
                <Badge tone={agentTone(p.id)} className="agent-badge">
                  {p.label}
                </Badge>{' '}
                <span className="mono-inline small">{p.bin}</span>
              </span>
              {found === null ? (
                <span className="quiet small">{t('agents.looking')}</span>
              ) : path ? (
                <Badge shape="pill" tone="good" title={path}>
                  {t('agents.installed')}
                </Badge>
              ) : (
                <Badge shape="pill">{t('agents.missing')}</Badge>
              )}
              {p.mcp === null && (
                <Badge shape="pill" title={t(p.how)}>
                  {t('agents.terminalOnly')}
                </Badge>
              )}
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
        <Button variant="link" size="sm" className="inline-link" disabled={looking} onClick={() => void look(true)}>
          {looking ? t('agents.looking') : t('agents.lookAgain')}
        </Button>{' '}
        {t('agents.lookNote')}
      </p>

      <h3 className="settings-sub">{t('agents.customTitle')}</h3>
      {customs.length === 0 && <EmptyState className="small">{t('agents.customNone')}</EmptyState>}
      <ul className="agent-list">
        {customs.map(c => (
          <li key={c.id} className="agent-row">
            <span className="agent-row-name">
              <Badge className="agent-badge">{c.name}</Badge> <span className="mono-inline small">{c.command}</span>
            </span>
            <span className="quiet small agent-row-how">{c.mcp === 'none' ? t('agents.customPlain') : t('agents.via', { how: c.mcp })}</span>
            <Button variant="link" size="sm" onClick={() => void save(customs.filter(o => o.id !== c.id))}>
              {t('agents.remove')}
            </Button>
          </li>
        ))}
      </ul>
      <h4 className="settings-sub-small">{t('agents.secAdd')}</h4>
      <div className="agent-form">
        <label>
          <span className="small">{t('agents.name')}</span>
          <Input placeholder={t('agents.namePlaceholder')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          <span className="small">{t('agents.command')}</span>
          <Input
            mono
            placeholder={t('agents.commandPlaceholder')}
            value={form.command}
            onChange={e => setForm({ ...form, command: e.target.value })}
          />
        </label>
        <label>
          <span className="small">{t('agents.mcp')}</span>
          <Input
            mono
            placeholder={t('agents.mcpPlaceholder', { example: '{server}' })}
            value={form.mcp}
            onChange={e => setForm({ ...form, mcp: e.target.value })}
          />
        </label>
        <p className="quiet small">
          {t('agents.mcpHelp', { list: PLACEHOLDERS.map(p => `{${p}}`).join(', ') })}
          <More>{t('agents.mcpHelpMore', { file: '{config_file}' })}</More>
        </p>
        <p className="quiet small">
          {t('agents.llama')}
          <More>{t('agents.llamaMore', { example: '{server}' })}</More>
        </p>
        {error && <p className="error small">{error}</p>}
        <div className="actions">
          <Button disabled={!form.name.trim() || !form.command.trim()} onClick={() => void add()}>
            {t('agents.add')}
          </Button>
          <span className="quiet small">{t('agents.addNote')}</span>
        </div>
      </div>
    </section>
  )
}
