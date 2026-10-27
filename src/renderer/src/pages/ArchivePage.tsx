import type { Task } from '../../../shared/types'
import { clock } from '../model'
import { NumberBadge } from '../parts'
import { t } from '../../../shared/i18n'

export function ArchivePage({ archived, onRestore }: { archived: Task[]; onRestore: (id: number) => void }) {
  return (
    <div className="card wide">
      <h1>{t('rail.archive')}</h1>
      <p className="quiet small">{t('archive.intro')}</p>
      {archived.length === 0 && <p className="quiet">{t('sidebar.noArchived')}</p>}
      <table className="history archive-table">
        <tbody>
          {archived.map(task => (
            <tr key={task.id}>
              <td>
                <NumberBadge task={task} />
              </td>
              <td>{task.title}</td>
              <td className="quiet">{task.project}</td>
              <td className="quiet">{task.archived_at ? clock(task.archived_at) : ''}</td>
              <td className="archive-action">
                <button className="link" onClick={() => onRestore(task.id)}>
                  {t('sidebar.restore')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
