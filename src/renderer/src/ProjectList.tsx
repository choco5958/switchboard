import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { Icon } from './Icons'
import { composing } from './ime'
import { useToast } from './parts'
import { Button, IconButton, Input, Menu, MenuItem, MenuSeparator, cx } from './ui'
import { t } from '../../shared/i18n'
import {
  FOLDERS_KEY,
  HIDDEN_KEY,
  hiddenProjects,
  moveToFolder,
  projectFolders,
  restoreFolder,
  sidebarGroups,
  type ProjectFolder,
  type ProjectInfo,
} from '../../shared/projects'

// The project switcher at the top of the sidebar: every project, the folders the person sorts
// them into (each opens and closes), and the projects taken off the list. A project moves by
// dragging it onto a folder or through its ⋯ menu (also on right-click). Keys: F2 renames a
// focused folder and Delete (or Backspace) deletes it, Delete takes a focused project off the
// list, and the menu (ui.tsx Menu) takes arrows and Esc and hands focus back.

const DRAG_TYPE = 'application/x-switchboard-project'

type Props = {
  projects: ProjectInfo[]
  hidden: string[]
  folders: ProjectFolder[]
  scope: string | null
  totals: { running: number; pending: number }
  badges: (name: string) => ReactNode
  // Decisions waiting in each project taken off the list, so they are not missed.
  hiddenPending?: Record<string, number>
  onScope: (name: string | null) => void
  onAddProject: () => void
  // A change built on the latest saved value of the setting (writes still on their way included).
  update: (key: string, change: (current: unknown) => unknown) => void
}

export function ProjectList({ projects, hidden, folders, scope, totals, badges, hiddenPending = {}, onScope, onAddProject, update }: Props) {
  const toast = useToast()
  // `p:<name>` or `f:<id>`: whose ⋯ menu is open.
  const [menu, setMenu] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [dropOn, setDropOn] = useState<string | null>(null)
  // The row (with its ⋯ button) whose menu is open: a press inside it is not a click outside.
  const menuRow = useRef<HTMLDivElement | null>(null)

  const openMenuAt = (key: string) => (event: MouseEvent) => {
    event.preventDefault()
    setMenu(key)
  }

  const groups = sidebarGroups(projects, folders)
  const changeFolders = (change: (current: ProjectFolder[]) => ProjectFolder[]) => update(FOLDERS_KEY, current => change(projectFolders(current)))
  const newFolder = (project?: string) => {
    const id = `f${Date.now().toString(36)}`
    const folder: ProjectFolder = { id, name: t('sidebar.newFolderName'), projects: [], closed: false }
    changeFolders(current => (project ? moveToFolder([...current, folder], project, id) : [...current, folder]))
    setEditing(id)
  }
  const rename = (id: string, name: string) => {
    setEditing(null)
    const clean = name.trim()
    if (clean) changeFolders(current => current.map(f => (f.id === id ? { ...f, name: clean } : f)))
  }
  const toggle = (id: string) => changeFolders(current => current.map(f => (f.id === id ? { ...f, closed: !f.closed } : f)))
  const move = (name: string, folderId: string | null) => changeFolders(current => moveToFolder(current, name, folderId))
  const unhide = (name: string) => update(HIDDEN_KEY, current => hiddenProjects(current).filter(h => h !== name))
  const hide = (name: string) => {
    const wasScope = scope === name
    update(HIDDEN_KEY, current => [...hiddenProjects(current).filter(h => h !== name), name])
    if (wasScope) onScope(null)
    toast(t('sidebar.hiddenToast', { name }), 'info', {
      label: t('common.undo'),
      run: () => {
        unhide(name)
        if (wasScope) onScope(name)
      },
    })
  }
  const ungroup = (folder: ProjectFolder) => {
    const index = folders.findIndex(f => f.id === folder.id)
    changeFolders(current => current.filter(f => f.id !== folder.id))
    toast(t('sidebar.ungroupedToast', { name: folder.name }), 'info', {
      label: t('common.undo'),
      run: () => changeFolders(current => restoreFolder(current, folder, index)),
    })
  }

  const dragOver = (target: string) => (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    setDropOn(target)
  }
  const drop = (folderId: string | null) => (event: DragEvent) => {
    const name = event.dataTransfer.getData(DRAG_TYPE)
    setDropOn(null)
    if (!name) return
    event.preventDefault()
    event.stopPropagation()
    move(name, folderId)
  }

  const moreButton = (key: string, label: string) => (
    <IconButton
      icon="more"
      size="sm"
      className="row-more"
      data-more={key}
      label={label}
      aria-haspopup="menu"
      aria-expanded={menu === key}
      onClick={() => setMenu(menu === key ? null : key)}
    />
  )

  const projectRow = (p: ProjectInfo, folder: ProjectFolder | null) => (
    <div key={p.name} className="project-line" ref={menu === `p:${p.name}` ? menuRow : undefined}>
      <button
        type="button"
        className={cx('row project-row', scope === p.name && 'on', folder && 'in-folder')}
        aria-current={scope === p.name ? 'true' : undefined}
        title={p.cwd || p.name}
        draggable
        onDragStart={event => {
          event.dataTransfer.setData(DRAG_TYPE, p.name)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDropOn(null)}
        onClick={() => onScope(p.name)}
        onContextMenu={openMenuAt(`p:${p.name}`)}
        onKeyDown={event => {
          if (event.key === 'Delete') {
            event.preventDefault()
            hide(p.name)
          }
        }}
      >
        <span className="project-name">{p.name}</span>
        {badges(p.name)}
        {p.running > 0 && <span className="quiet small project-running">{t('sidebar.running', { n: p.running })}</span>}
        {p.pending > 0 && (
          <span className="count warn" title={t('sidebar.pendingTitle', { n: p.pending })}>
            {p.pending}
          </span>
        )}
      </button>
      {moreButton(`p:${p.name}`, t('sidebar.projectMenu'))}
      {menu === `p:${p.name}` && (
        <Menu label={t('sidebar.projectMenu')} className="row-menu" within={menuRow} onClose={() => setMenu(null)}>
          {folders
            .filter(f => f.id !== folder?.id)
            .map(f => (
              <MenuItem key={f.id} icon="folder" onSelect={() => move(p.name, f.id)}>
                {t('sidebar.moveTo', { name: f.name })}
              </MenuItem>
            ))}
          <MenuItem icon="folder" onSelect={() => newFolder(p.name)}>
            {t('sidebar.moveToNew')}
          </MenuItem>
          {folder && <MenuItem onSelect={() => move(p.name, null)}>{t('sidebar.moveOut')}</MenuItem>}
          <MenuSeparator />
          <MenuItem title={t('sidebar.hideTitle')} onSelect={() => hide(p.name)}>
            {t('sidebar.hide')}
          </MenuItem>
        </Menu>
      )}
    </div>
  )

  const hiddenWaiting = hidden.reduce((n, name) => n + (hiddenPending[name] ?? 0), 0)

  return (
    <section
      className={`projects ${dropOn === 'loose' ? 'drop-on' : ''}`}
      onDragOver={dragOver('loose')}
      onDragLeave={() => setDropOn(null)}
      onDrop={drop(null)}
    >
      <div className="projects-head">
        <h2>{t('sidebar.projects')}</h2>
        <span className="projects-actions">
          <Button variant="link" size="sm" title={t('sidebar.newFolderTitle')} onClick={() => newFolder()}>
            {t('sidebar.newFolder')}
          </Button>
          <Button variant="link" size="sm" onClick={onAddProject}>
            {t('sidebar.addFolder')}
          </Button>
        </span>
      </div>
      <button type="button" className={cx('row project-row', scope === null && 'on')} aria-current={scope === null ? 'true' : undefined} onClick={() => onScope(null)}>
        <span className="project-name">{t('sidebar.all')}</span>
        {totals.running > 0 && <span className="quiet small project-running">{t('sidebar.running', { n: totals.running })}</span>}
        {totals.pending > 0 && (
          <span className="count warn" title={t('sidebar.pendingTitle', { n: totals.pending })}>
            {totals.pending}
          </span>
        )}
      </button>
      {groups.folders.map(({ folder, items, running, pending }) => (
        <div key={folder.id} className={`project-folder ${dropOn === folder.id ? 'drop-on' : ''}`} onDragOver={dragOver(folder.id)} onDrop={drop(folder.id)}>
          <div className="project-line" ref={menu === `f:${folder.id}` ? menuRow : undefined}>
            {editing === folder.id ? (
              <Input
                compact
                className="folder-name-input"
                aria-label={t('sidebar.folderName')}
                defaultValue={folder.name}
                autoFocus
                onFocus={event => event.target.select()}
                onBlur={event => rename(folder.id, event.target.value)}
                onKeyDown={event => {
                  if (composing(event)) return
                  if (event.key === 'Enter') rename(folder.id, event.currentTarget.value)
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              // One click opens or closes; renaming is F2 or the ⋯ menu, so a double click never toggles twice.
              <button
                type="button"
                className="row project-row folder-row"
                aria-expanded={!folder.closed}
                title={t(folder.closed ? 'sidebar.openFolder' : 'sidebar.closeFolder')}
                onClick={() => toggle(folder.id)}
                onContextMenu={openMenuAt(`f:${folder.id}`)}
                onKeyDown={event => {
                  if (event.key === 'F2') {
                    event.preventDefault()
                    setEditing(folder.id)
                  }
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    ungroup(folder)
                  }
                }}
              >
                <span className={`folder-chevron ${folder.closed ? '' : 'open'}`}>
                  <Icon name="expand" size="sm" />
                </span>
                <Icon name="folder" size="sm" />
                <span className="project-name">{folder.name}</span>
                <span className="quiet small">{items.length}</span>
                {folder.closed && running > 0 && <span className="quiet small project-running">{t('sidebar.running', { n: running })}</span>}
                {folder.closed && pending > 0 && (
                  <span className="count warn" title={t('sidebar.pendingTitle', { n: pending })}>
                    {pending}
                  </span>
                )}
              </button>
            )}
            {moreButton(`f:${folder.id}`, t('sidebar.folderMenu'))}
            {menu === `f:${folder.id}` && (
              <Menu label={t('sidebar.folderMenu')} className="row-menu" within={menuRow} onClose={() => setMenu(null)}>
                <MenuItem onSelect={() => setEditing(folder.id)}>{t('sidebar.renameFolder')}</MenuItem>
                <MenuItem title={t('sidebar.removeFolderTitle')} onSelect={() => ungroup(folder)}>
                  {t('sidebar.removeFolder')}
                </MenuItem>
              </Menu>
            )}
          </div>
          {!folder.closed && (
            <div className="folder-items">
              {items.map(p => projectRow(p, folder))}
              {items.length === 0 && <p className="quiet small folder-empty">{t('sidebar.folderEmpty')}</p>}
            </div>
          )}
        </div>
      ))}
      {groups.loose.map(p => projectRow(p, null))}
      {hidden.length > 0 && (
        <div className="hidden-projects">
          <Button variant="link" size="sm" aria-expanded={showHidden} onClick={() => setShowHidden(open => !open)}>
            {t('sidebar.hidden', { n: hidden.length })}
            {hiddenWaiting > 0 && (
              <>
                {' '}
                <span className="count warn" title={t('sidebar.pendingTitle', { n: hiddenWaiting })}>
                  {hiddenWaiting}
                </span>
              </>
            )}
          </Button>
          {showHidden &&
            hidden.map(name => (
              <div key={name} className="hidden-project">
                <span className="project-name quiet">{name}</span>
                {(hiddenPending[name] ?? 0) > 0 && (
                  <span className="count warn" title={t('sidebar.pendingTitle', { n: hiddenPending[name] ?? 0 })}>
                    {hiddenPending[name]}
                  </span>
                )}
                <Button variant="link" size="sm" onClick={() => unhide(name)}>
                  {t('sidebar.unhide')}
                </Button>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}
