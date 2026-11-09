import { useEffect, useRef, useState } from 'react'
import type { AccountRow, AgentDetect } from '../../../shared/types'
import { accountSpec } from '../../../shared/accounts'
import { agentOf } from '../../../shared/agents'
import { agentTone, useToast } from '../parts'
import { Badge, Button, Dialog, Input, SettingGroup, SettingRow } from '../ui'
import { LOCALE_TAG, getLang, t } from '../../../shared/i18n'

const POLL_MS = 5_000

type Account = AccountRow['accounts'][number]

// What a row is called: the person's name for it, else its number (account 1 is the CLI's own login).
export function accountLabel(account: Pick<Account, 'id' | 'name'>): string {
  return account.name || (account.id === 1 ? t('accounts.default') : t('accounts.numbered', { n: account.id }))
}

function usageText(usage: Account['usage']): string {
  if (!usage) return ''
  const pct = (value?: number) => (value === undefined ? '-' : `${Math.round(value)}%`)
  return t('accounts.usage', { five: pct(usage.five), week: pct(usage.week) })
}

// The settings section of the accounts of each installed agent CLI (src/main/accounts.ts), as Orca
// lays its own out: a group per CLI, a row per account. Pressing a row makes it the account new
// sessions start on; adding one opens a terminal in the dock that signs in on it, and the list
// notices the login by itself.
export function AccountsSection() {
  const toast = useToast()
  const [rows, setRows] = useState<AccountRow[] | null>(null)
  const [found, setFound] = useState<AgentDetect | null>(null)
  const [ccr, setCcr] = useState(false)
  const [renaming, setRenaming] = useState<{ agent: string; id: number; name: string } | null>(null)
  const [removing, setRemoving] = useState<{ agent: string; account: Account } | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  const load = () => void window.ide.accountsList().then(setRows, () => setRows([]))
  useEffect(() => {
    load()
    void window.ide.detectAgents(false).then(setFound, () => undefined)
    void window.ide.accountInfo().then(info => setCcr(!!info?.ccr), () => undefined)
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const opened = (reply: { error: string } | object, agent: string) => {
    if ('error' in reply) toast(reply.error, 'bad')
    else toast(t('accounts.loginOpened', { agent: agentOf(agent)?.label ?? agent }))
    load()
  }

  const select = async (agent: string, id: number) => {
    if (await window.ide.accountsSelect(agent, id)) load()
  }

  const rename = async () => {
    if (!renaming) return
    await window.ide.accountsRename(renaming.agent, renaming.id, renaming.name)
    setRenaming(null)
    load()
  }

  const remove = async () => {
    if (!removing) return
    await window.ide.accountsRemove(removing.agent, removing.account.id)
    setRemoving(null)
    load()
  }

  if (rows === null) return <p className="quiet small">{t('common.loading')}</p>
  const shown = rows.filter(row => found === null || !!found.found[agentOf(row.agent)?.bin ?? row.agent])
  if (shown.length === 0) return <SettingGroup><SettingRow title={t('accounts.none')} /></SettingGroup>

  return (
    <>
      {removing && (
        <Dialog label={t('accounts.removeTitle')} onClose={() => setRemoving(null)} initial={cancel} className="risky-confirm">
          <h2>{t('accounts.removeTitle')}</h2>
          <div className="risky-body">
            <p>
              {agentOf(removing.agent)?.label ?? removing.agent}: {accountLabel(removing.account)}
              {removing.account.email && <span className="mono-inline quiet"> {removing.account.email}</span>}
            </p>
            <p className="quiet small">{t('accounts.removeNote')}</p>
          </div>
          <div className="actions risky-actions">
            <Button ref={cancel} onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t('accounts.remove')}
            </Button>
          </div>
        </Dialog>
      )}
      {shown.map(row => {
        const label = agentOf(row.agent)?.label ?? row.agent
        if (row.agent === 'claude' && ccr)
          return (
            <SettingGroup key={row.agent} title={label}>
              <SettingRow title={t('accounts.ccr')} />
            </SettingGroup>
          )
        const moves = !!accountSpec(row.agent)?.limit || row.agent === 'claude' || row.agent === 'codex'
        return (
          <SettingGroup key={row.agent} title={<Badge tone={agentTone(row.agent)} className="agent-badge">{label}</Badge>}>
            <p className="setting-hint account-group-hint">{moves ? t('accounts.groupHint') : t('accounts.groupHintNoMove', { agent: label })}</p>
            <ul className="account-rows" role="radiogroup" aria-label={t('accounts.title')}>
              {row.accounts.map(account => {
                const active = account.id === row.active
                const held = account.until !== undefined && account.until > Date.now()
                const editing = renaming?.agent === row.agent && renaming.id === account.id
                const usage = usageText(account.usage)
                return (
                  <li key={account.id} className={`account-row ${active ? 'active' : ''} ${held ? 'held' : ''}`}>
                    <button type="button" role="radio" aria-checked={active} className="account-pick" onClick={() => void select(row.agent, account.id)}>
                      <span className="account-line">
                        <span className="account-name">{accountLabel(account)}</span>
                        {active && (
                          <Badge shape="pill" tone="accent">
                            {t('accounts.active')}
                          </Badge>
                        )}
                        {!account.signedIn && (
                          <Badge shape="pill" tone="bad">
                            {t('accounts.notSignedIn')}
                          </Badge>
                        )}
                        {held && (
                          <Badge shape="pill" tone="bad">
                            {t('accounts.limited', { time: new Date(account.until!).toLocaleString(LOCALE_TAG[getLang()], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}
                          </Badge>
                        )}
                      </span>
                      <span className="account-detail small quiet">
                        {[account.email, account.id === 1 ? t('accounts.defaultDetail') : '', usage].filter(Boolean).join(', ')}
                      </span>
                    </button>
                    {account.id > 1 && (
                      <span className="account-actions">
                        {editing ? (
                          <>
                            <Input
                              className="account-rename"
                              autoFocus
                              placeholder={t('accounts.namePlaceholder')}
                              value={renaming.name}
                              onChange={e => setRenaming({ ...renaming, name: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') void rename()
                                if (e.key === 'Escape') setRenaming(null)
                              }}
                            />
                            <Button size="sm" onClick={() => void rename()}>
                              {t('accounts.save')}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setRenaming({ agent: row.agent, id: account.id, name: account.name })}>
                            {t('accounts.rename')}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => void window.ide.accountsLogin(row.agent, account.id).then(reply => opened(reply, row.agent))}>
                          {t('accounts.login')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving({ agent: row.agent, account })}>
                          {t('accounts.remove')}
                        </Button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="account-add">
              <Button size="sm" onClick={() => void window.ide.accountsAdd(row.agent).then(reply => opened(reply, row.agent))}>
                {t('accounts.add')}
              </Button>
            </div>
          </SettingGroup>
        )
      })}
    </>
  )
}
