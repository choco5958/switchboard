import { useEffect, useState } from 'react'
import type { AccountRow, AgentDetect } from '../../../shared/types'
import { agentOf } from '../../../shared/agents'
import { useToast } from '../parts'
import { Badge, Button, Input, SettingGroup, SettingRow } from '../ui'
import { LOCALE_TAG, getLang, t } from '../../../shared/i18n'

const POLL_MS = 5_000

// The accounts of each installed agent CLI (src/main/accounts.ts). Adding one opens a terminal in
// the dock that signs in on it; the list notices the login by itself.
export function AccountsSection({ found }: { found: AgentDetect | null }) {
  const toast = useToast()
  const [rows, setRows] = useState<AccountRow[] | null>(null)
  const [ccr, setCcr] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})

  const load = () => void window.ide.accountsList().then(setRows, () => setRows([]))
  useEffect(() => {
    load()
    void window.ide.accountInfo().then(info => setCcr(!!info?.ccr), () => undefined)
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const opened = (reply: { error: string } | object, agent: string) => {
    if ('error' in reply) toast(reply.error, 'bad')
    else toast(t('accounts.loginOpened', { agent: agentOf(agent)?.label ?? agent }))
    load()
  }

  const rename = async (agent: string, id: number) => {
    const key = `${agent}:${id}`
    if (names[key] === undefined) return
    await window.ide.accountsRename(agent, id, names[key]!)
    setNames(({ [key]: _, ...rest }) => rest)
    load()
  }

  const shown = (rows ?? []).filter(row => found === null || !!found.found[agentOf(row.agent)?.bin ?? row.agent])
  return (
    <SettingGroup title={t('accounts.title')}>
      <SettingRow title={t('accounts.how')} hint={t('accounts.hint')} />
      {shown.map(row => {
        const label = agentOf(row.agent)?.label ?? row.agent
        if (row.agent === 'claude' && ccr) return <SettingRow key={row.agent} title={label} hint={t('accounts.ccr')} />
        return (
          <div key={row.agent} className="setting-row account-agent">
            <div className="setting-text">
              <div className="setting-title">{label}</div>
              <ul className="account-list">
                {row.accounts.map(account => {
                  const key = `${row.agent}:${account.id}`
                  const held = account.until !== undefined && account.until > Date.now()
                  return (
                    <li key={account.id} className="account-item small">
                      <span className="account-name">{account.id === 1 ? t('accounts.default') : t('accounts.numbered', { n: account.id })}</span>
                      {account.email && <span className="mono-inline quiet">{account.email}</span>}
                      {!account.signedIn && <Badge shape="pill">{t('accounts.notSignedIn')}</Badge>}
                      {held && (
                        <Badge shape="pill" tone="bad">
                          {t('accounts.limited', { time: new Date(account.until!).toLocaleString(LOCALE_TAG[getLang()], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}
                        </Badge>
                      )}
                      {account.id > 1 && (
                        <>
                          <Input
                            className="account-rename"
                            placeholder={t('accounts.namePlaceholder')}
                            value={names[key] ?? account.name}
                            onChange={e => setNames({ ...names, [key]: e.target.value })}
                            onBlur={() => void rename(row.agent, account.id)}
                            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                          />
                          <Button size="sm" variant="ghost" onClick={() => void window.ide.accountsLogin(row.agent, account.id).then(reply => opened(reply, row.agent))}>
                            {t('accounts.login')}
                          </Button>
                          <Button size="sm" variant="ghost" title={t('accounts.removeNote')} onClick={() => void window.ide.accountsRemove(row.agent, account.id).then(load)}>
                            {t('accounts.remove')}
                          </Button>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
            <Button size="sm" onClick={() => void window.ide.accountsAdd(row.agent).then(reply => opened(reply, row.agent))}>
              {t('accounts.add')}
            </Button>
          </div>
        )
      })}
    </SettingGroup>
  )
}
