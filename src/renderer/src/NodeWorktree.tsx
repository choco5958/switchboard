import { useEffect, useState } from 'react'
import type { GraphNode, WorktreeCheck } from '../../shared/types'
import { t } from '../../shared/i18n'
import { Button } from './ui'

// The worktree of the node picked in the graph, in the properties panel under its rows: check
// what would be lost, then remove it. Anything unsaved or unmerged needs a second press.
export function NodeWorktree({ node }: { node: GraphNode }) {
  const [check, setCheck] = useState<WorktreeCheck | null>(null)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // A fresh check (or none) always needs its own second press.
  useEffect(() => setArmed(false), [check])

  if (!node.worktree) return <p className="small quiet">{t('taskView.noWorktree')}</p>
  const worktree = node.worktree

  const inspect = async () => {
    setBusy(true)
    setCheck(await window.ide.checkWorktree(worktree, node.branch ?? ''))
    setBusy(false)
  }

  const risky = check !== null && check.exists && (check.changed.length > 0 || (!check.merged && check.unpushed > 0))

  const remove = async () => {
    if (risky && !armed) return setArmed(true)
    setBusy(true)
    const reply = await window.ide.removeWorktree(node.id, worktree, check?.changed.length ? true : false)
    setBusy(false)
    setMessage(reply.ok ? t('taskView.removed') : t('taskView.removeFailed', { error: String(reply.json.error ?? '') }))
  }

  return (
    <div className="node-worktree">
      {!check && (
        <Button size="sm" disabled={busy} onClick={() => void inspect()}>
          {t('taskView.checkFirst')}
        </Button>
      )}
      {check && !check.exists && <p className="small quiet">{t('taskView.folderGone')}</p>}
      {check && check.exists && (
        <ul className="small check">
          <li className={check.changed.length > 0 ? 'bad' : 'good'}>
            {t('taskView.uncommitted', { n: check.changed.length })}
            {check.changed.length > 0 ? `: ${check.changed.slice(0, 5).join(', ')}` : ''}
          </li>
          <li className={check.merged ? 'good' : 'warn'}>{check.merged ? t('taskView.merged', { base: check.base }) : t('taskView.notMerged', { base: check.base })}</li>
          <li className={check.unpushed > 0 ? 'warn' : 'good'}>{t('taskView.unpushed', { n: check.unpushed })}</li>
        </ul>
      )}
      {check && (
        <Button size="sm" variant={armed ? 'danger' : 'default'} disabled={busy || message !== ''} onClick={() => void remove()}>
          {armed ? t('taskView.removeAnyway') : t('taskView.remove')}
        </Button>
      )}
      {message && <p className="small">{message}</p>}
    </div>
  )
}
