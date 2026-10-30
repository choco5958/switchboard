import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Icon } from './Icons'
import { composing } from './ime'
import { t } from '../../shared/i18n'
import { FOLDERS_KEY, HIDDEN_KEY, moveToFolder, sidebarGroups, type ProjectFolder, type ProjectInfo } from '../../shared/projects'

// The project switcher at the top of the sidebar: every project, the folders the person sorts
// them into (each opens and closes), and the projects taken off the list. A project moves by
// dragging it onto a folder or through its ⋯ menu.

const DRAG_TYPE = 'application/x-switchboard-project'

type Props = {
  projects: ProjectInfo[]
  hidden: string[]
  folders: ProjectFolder[]
  scope: string | null
  totals: { running: number; pending: number }
  badges: (name: string) => ReactNode
  onScope: (name: string | null) => void
  onAddProject: () => void
  save: (key: string, value: unknown) => void
}

export function ProjectList({ projects, hidden, folders, scope, totals, badges, onScope, onAddProject, save }: Props) {
  // `p:<name>` or `f:<id>`: whose ⋯ menu is open.
  const [menu, setMenu] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])

  const groups = sidebarGroups(projects, folders)
  const saveFolders = (next: ProjectFolder[]) => save(FOLDERS_KEY, next)
  const newFolder = (project?: string) => {
    const id = `f${Date.now().toString(36)}`
    const folder: ProjectFolder = { id, name: t('sidebar.newFolderName'), projects: [], closed: false }
    saveFolders(project ? moveToFolder([...folders, folder], project, id) : [...folders, folder])
    setEditing(id)
  }
  const rename = (id: string, name: string) => {
    setEditing(null)
    const clean = name.trim()
    if (clean) saveFolders(folders.map(f => (f.id === id ? { ...f, name: clean } : f)))
  }
  const hide = (name: string) => {
    save(HIDDEN_KEY, [...hidden.filter(h => h !== name), name])
    if (scope === name) onScope(null)
  }
  const unhide = (name: string) => save(HIDDEN_KEY, hidden.filter(h => h !== name))

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
    saveFolders(moveToFolder(folders, name, folderId))
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
      <button className="row-more" title={t('sidebar.projectMenu')} aria-label={t('sidebar.projectMenu')} onClick={() => setMenu(menu === `p:${p.name}` ? null : `p:${p.name}`)}>
        <Icon name="more" size={14} />
      </button>
      {menu === `p:${p.name}` && (
        <div className="row-menu" role="menu">
          {folders
            .filter(f => f.id !== folder?.id)
            .map(f => (
              <button key={f.id} role="menuitem" onClick={() => (setMenu(null), saveFolders(moveToFolder(folders, p.name, f.id)))}>
                <Icon name="folder" size={13} />
                {t('sidebar.moveTo', { name: f.name })}
              </button>
            ))}
          <button role="menuitem" onClick={() => (setMenu(null), newFolder(p.name))}>
            <Icon name="folder" size={13} />
            {t('sidebar.moveToNew')}
          </button>
          {folder && (
            <button role="menuitem" onClick={() => (setMenu(null), saveFolders(moveToFolder(folders, p.name, null)))}>
              {t('sidebar.moveOut')}
            </button>
          )}
          <hr />
          <button role="menuitem" title={t('sidebar.hideTitle')} onClick={() => (setMenu(null), hide(p.name))}>
            {t('sidebar.hide')}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <section className={`projects ${dropOn === 'loose' ? 'drop-on' : ''}`} onDragOver={dragOver('loose')} onDragLeave={() => setDropOn(null)} onDrop={drop(null)}>
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
              <button
                className="project-row folder-row"
                aria-expanded={!folder.closed}
                title={t(folder.closed ? 'sidebar.openFolder' : 'sidebar.closeFolder')}
                onClick={() => saveFolders(folders.map(f => (f.id === folder.id ? { ...f, closed: !f.closed } : f)))}
                onDoubleClick={() => setEditing(folder.id)}
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
            <button className="row-more" title={t('sidebar.folderMenu')} aria-label={t('sidebar.folderMenu')} onClick={() => setMenu(menu === `f:${folder.id}` ? null : `f:${folder.id}`)}>
              <Icon name="more" size={14} />
            </button>
            {menu === `f:${folder.id}` && (
              <div className="row-menu" role="menu">
                <button role="menuitem" onClick={() => (setMenu(null), setEditing(folder.id))}>
                  {t('sidebar.renameFolder')}
                </button>
                <button role="menuitem" title={t('sidebar.removeFolderTitle')} onClick={() => (setMenu(null), saveFolders(folders.filter(f => f.id !== folder.id)))}>
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
          </button>
          {showHidden &&
            hidden.map(name => (
              <div key={name} className="hidden-project">
                <span className="project-name quiet">{name}</span>
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
