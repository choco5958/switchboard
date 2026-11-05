import { useEffect, useState } from 'react'
import type { AgentDetect } from '../../../shared/types'
import { CLOSE_TERMINALS_KEY, CODEX_APPROVALS_KEY, CUSTOM_AGENTS_KEY, PLACEHOLDERS, PRESETS, SHOW_OTHER_AGENTS_KEY, TRUST_FOLDERS_KEY, customAgents, showOtherAgents, trustFolders, validateCustom } from '../../../shared/agents'
import { AGENTS_FOUND } from '../Dock'
import { agentTone, useToast } from '../parts'
import { Badge, Button, Input, More, SettingGroup, SettingRow, Switch } from '../ui'
import { Icon } from '../Icons'
import { t } from '../../../shared/i18n'
import { tx } from '../tx'
import { saveSetting } from '../settings'
import { BROWSER_LAN_KEY } from '../agentBrowser'
import { RiskyConfirm } from '../flows'

// Settings for agent CLIs other than Claude Code: which presets are installed, and
// the person's own entries. Saving an entry runs nothing; its dock button does.
// `part`: the CLIs (the dock, the list, the person's own) or what lets sessions reach further.
export function AgentSettings({ settings, part = 'cli' }: { settings: Record<string, unknown>; part?: 'cli' | 'safety' }) {
  const toast = useToast()
  const customs = customAgents(settings[CUSTOM_AGENTS_KEY])
  const showOthers = showOtherAgents(settings[SHOW_OTHER_AGENTS_KEY])
  const trusting = trustFolders(settings[TRUST_FOLDERS_KEY])
  const closeOnQuit = settings[CLOSE_TERMINALS_KEY] === true
  const codexApprovals = settings[CODEX_APPROVALS_KEY] === true
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

  const toggleCodexApprovals = async () => {
    const reply = await saveSetting(CODEX_APPROVALS_KEY, codexApprovals ? null : true)
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

  if (part === 'safety')
    return (
      <>
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
        <SettingGroup>
          <SettingRow title={t('agents.trustFolders')} hint={t('agents.trustFoldersHint')} more={t('agents.trustFoldersHintMore')}>
            <Switch checked={trusting} onChange={() => void toggleTrust()} label={t('agents.trustFolders')} />
          </SettingRow>
          <SettingRow title={t('agents.codexApprovals')} hint={t('agents.codexApprovalsHint')} more={t('agents.codexApprovalsHintMore')}>
            <Switch checked={codexApprovals} onChange={() => void toggleCodexApprovals()} label={t('agents.codexApprovals')} />
          </SettingRow>
          <SettingRow title={t('agents.browserLan')} hint={t('agents.browserLanHint')} more={t('agents.browserLanHintMore')}>
            <Switch checked={browserLan} onChange={() => void toggleBrowserLan()} label={t('agents.browserLan')} />
          </SettingRow>
        </SettingGroup>
      </>
    )

  return (
    <>
      <SettingGroup title={t('agents.secDock')}>
        <SettingRow title={t('agents.showOthers')} hint={t('agents.showOthersHint')}>
          <Switch checked={showOthers} onChange={() => void toggleOthers()} label={t('agents.showOthers')} />
        </SettingRow>
        {keeps === true && (
          <SettingRow title={t('agents.closeOnQuit')} hint={t('agents.closeOnQuitHint')} more={t('agents.closeOnQuitHintMore')}>
            <Switch checked={closeOnQuit} onChange={() => void toggleCloseOnQuit()} label={t('agents.closeOnQuit')} />
          </SettingRow>
        )}
        {keeps === false && <SettingRow title={t('agents.closeOnQuit')} hint={t('agents.closeOnQuitOff')} />}
      </SettingGroup>

      <SettingGroup title={t('agents.secCli')} className="agent-cards">
        {PRESETS.map(p => {
          const path = found?.found[p.bin]
          return (
            <details key={p.id} className="agent-card">
              <summary>
                <Badge tone={agentTone(p.id)} className="agent-badge">
                  {p.label}
                </Badge>
                <span className="mono-inline small quiet">{p.bin}</span>
                <span className="agent-card-tags">
                  {p.mcp === null && <Badge shape="pill">{t('agents.terminalOnly')}</Badge>}
                  {found === null ? (
                    <span className="quiet small">{t('agents.looking')}</span>
                  ) : path ? (
                    <Badge shape="pill" tone="good" title={path}>
                      {t('agents.installed')}
                    </Badge>
                  ) : (
                    <Badge shape="pill">{t('agents.missing')}</Badge>
                  )}
                </span>
                <span className="agent-card-open"><Icon name="chevronDown" size="sm" /></span>
              </summary>
              <div className="agent-card-body small">
                <p className="quiet">{p.mcp ? t('agents.via', { how: t(p.how) }) : t(p.how)}</p>
                {found !== null && !path && <p>{tx('agents.installHint', { command: <code>{p.install}</code> })}</p>}
                <a href={p.docs} target="_blank" rel="noreferrer">
                  {t('agents.docs')}
                </a>
              </div>
            </details>
          )
        })}
        <SettingRow title={t('agents.lookAgain')} hint={t('agents.lookNote')}>
          <Button size="sm" disabled={looking} onClick={() => void look(true)}>
            {looking ? t('agents.looking') : t('agents.lookAgain')}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('agents.customTitle')}>
        {customs.length === 0 && <SettingRow title={t('agents.customNone')} />}
        {customs.map(c => (
          <SettingRow
            key={c.id}
            title={
              <>
                <Badge className="agent-badge">{c.name}</Badge> <span className="mono-inline small">{c.command}</span>
              </>
            }
            hint={c.mcp === 'none' ? t('agents.customPlain') : t('agents.via', { how: c.mcp })}
          >
            <Button size="sm" variant="ghost" onClick={() => void save(customs.filter(o => o.id !== c.id))}>
              {t('agents.remove')}
            </Button>
          </SettingRow>
        ))}
        <details className="agent-add">
          <summary>
            <span className="setting-title">{t('agents.secAdd')}</span>
            <span className="agent-card-open"><Icon name="chevronDown" size="sm" /></span>
          </summary>
          <div className="agent-form">
            <label>
              <span className="small">{t('agents.name')}</span>
              <Input placeholder={t('agents.namePlaceholder')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              <span className="small">{t('agents.command')}</span>
              <Input mono placeholder={t('agents.commandPlaceholder')} value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} />
            </label>
            <label>
              <span className="small">{t('agents.mcp')}</span>
              <Input mono placeholder={t('agents.mcpPlaceholder', { example: '{server}' })} value={form.mcp} onChange={e => setForm({ ...form, mcp: e.target.value })} />
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
        </details>
      </SettingGroup>
    </>
  )
}
