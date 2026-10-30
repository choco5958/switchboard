import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Icon } from './Icons'
import { composing } from './ime'
import { useToast } from './parts'
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
// focused folder, Delete takes a focused project off the list, and the menu takes arrows and Esc.

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
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLElement | null>(null)

  // Closing from the keyboard puts focus back on the ⋯ button that opened the menu.
  const closeMenu = (refocus: boolean) => {
    const key = menu
    setMenu(null)
    if (refocus && key) listRef.current?.querySelector<HTMLButtonElement>(`[data-more="${CSS.escape(key)}"]`)?.focus()
  }

  useEffect(() => {
    if (!menu) return
    // The first entry takes focus, so the arrows work right away.
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const close = (event: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus()
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focus(at + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focus(at - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focus(items.length - 1)
    } else if (event.key === 'Tab') closeMenu(false)
  }
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
    <button
      className="row-more"
      data-more={key}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menu === key}
      onClick={() => setMenu(menu === key ? null : key)}
    >
      <Icon name="more" size={14} />
    </button>
  )
  // Each entry closes the menu first and returns focus to the row's ⋯ button.
  const item = (run: () => void) => () => {
    closeMenu(true)
    run()
  }

  const projectRow = (p: ProjectInfo, folder: ProjectFolder | null) => (
    <div key={p.name} className="project-line" ref={menu === `p:${p.name}` ? menuRef : undefined}>
      <button
        className={`project-row ${scope === p.name ? 'on' : ''} ${folder ? 'in-folder' : ''}`}
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
        <div className="row-menu" role="menu" aria-label={t('sidebar.projectMenu')} onKeyDown={menuKeys}>
          {folders
            .filter(f => f.id !== folder?.id)
            .map(f => (
              <button key={f.id} role="menuitem" onClick={item(() => move(p.name, f.id))}>
                <Icon name="folder" size={13} />
                {t('sidebar.moveTo', { name: f.name })}
              </button>
            ))}
          <button role="menuitem" onClick={item(() => newFolder(p.name))}>
            <Icon name="folder" size={13} />
            {t('sidebar.moveToNew')}
          </button>
          {folder && (
            <button role="menuitem" onClick={item(() => move(p.name, null))}>
              {t('sidebar.moveOut')}
            </button>
          )}
          <hr />
          <button role="menuitem" title={t('sidebar.hideTitle')} onClick={item(() => hide(p.name))}>
            {t('sidebar.hide')}
          </button>
        </div>
      )}
    </div>
  )

  const hiddenWaiting = hidden.reduce((n, name) => n + (hiddenPending[name] ?? 0), 0)

  return (
    <section
      ref={listRef}
      className={`projects ${dropOn === 'loose' ? 'drop-on' : ''}`}
      onDragOver={dragOver('loose')}
      onDragLeave={() => setDropOn(null)}
      onDrop={drop(null)}
    >
      <div className="projects-head">
        <h2>{t('sidebar.projects')}</h2>
        <span className="projects-actions">
          <button className="link small" title={t('sidebar.newFolderTitle')} onClick={() => newFolder()}>
            {t('sidebar.newFolder')}
          </button>
          <button className="link small" onClick={onAddProject}>
            {t('sidebar.addFolder')}
          </button>
        </span>
      </div>
      <button className={`project-row ${scope === null ? 'on' : ''}`} onClick={() => onScope(null)}>
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
          <div className="project-line" ref={menu === `f:${folder.id}` ? menuRef : undefined}>
            {editing === folder.id ? (
              <input
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
                className="project-row folder-row"
                aria-expanded={!folder.closed}
                title={t(folder.closed ? 'sidebar.openFolder' : 'sidebar.closeFolder')}
                onClick={() => toggle(folder.id)}
                onContextMenu={openMenuAt(`f:${folder.id}`)}
                onKeyDown={event => {
                  if (event.key === 'F2') {
                    event.preventDefault()
                    setEditing(folder.id)
                  }
                }}
              >
                <span className={`folder-chevron ${folder.closed ? '' : 'open'}`}>
                  <Icon name="expand" size={12} />
                </span>
                <Icon name="folder" size={14} />
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
              <div className="row-menu" role="menu" aria-label={t('sidebar.folderMenu')} onKeyDown={menuKeys}>
                <button role="menuitem" onClick={() => (setMenu(null), setEditing(folder.id))}>
                  {t('sidebar.renameFolder')}
                </button>
                <button role="menuitem" title={t('sidebar.removeFolderTitle')} onClick={item(() => ungroup(folder))}>
                  {t('sidebar.removeFolder')}
                </button>
              </div>
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
          <button className="link small" aria-expanded={showHidden} onClick={() => setShowHidden(open => !open)}>
            {t('sidebar.hidden', { n: hidden.length })}
            {hiddenWaiting > 0 && (
              <>
                {' '}
                <span className="count warn" title={t('sidebar.pendingTitle', { n: hiddenWaiting })}>
                  {hiddenWaiting}
                </span>
              </>
            )}
          </button>
          {showHidden &&
            hidden.map(name => (
              <div key={name} className="hidden-project">
                <span className="project-name quiet">{name}</span>
                {(hiddenPending[name] ?? 0) > 0 && (
                  <span className="count warn" title={t('sidebar.pendingTitle', { n: hiddenPending[name] ?? 0 })}>
                    {hiddenPending[name]}
                  </span>
                )}
                <button className="link small" onClick={() => unhide(name)}>
                  {t('sidebar.unhide')}
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}
