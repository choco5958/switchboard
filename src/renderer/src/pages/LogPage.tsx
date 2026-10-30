import { useState } from 'react'
import type { LogEvent, Task } from '../../../shared/types'
import { LogLines } from '../parts'
import type { AgentTag } from '../../../shared/agents'
import { eventKindLabel, t } from '../../../shared/i18n'
import { Input } from '../ui'

export function LogPage({ events, tasks, agents }: { events: LogEvent[]; tasks: Task[]; agents?: Record<string, AgentTag> }) {
  const [filter, setFilter] = useState('')
  const shown = filter ? events.filter(e => `${e.task_title} ${e.project} ${e.kind} ${eventKindLabel(e.kind)} ${e.text}`.includes(filter)) : events
  return (
    <div className="card wide">
      <h1>{t('rail.log')}</h1>
      <Input className="log-filter" type="search" aria-label={t('log.filter')} placeholder={t('log.filter')} value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="worklog-body full">
        <LogLines events={shown} tasks={tasks} empty={filter ? t('log.noMatch') : t('dock.emptyLog')} />
      </div>
    </div>
  )
}
