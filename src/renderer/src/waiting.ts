import type { Approval, Question, Task } from '../../shared/types'
import { t, type Key } from '../../shared/i18n'
import type { Attention } from './model'

// The one "waiting for me" count. The left icon bar's badge, the top bar chip, the sidebar's
// "확인 필요" group and the palette all read it, so they never disagree.
//   questions  decision questions not answered or held (status pending)
//   approvals  permission asks not answered (status pending)
//   stalled    running tasks whose session's turn shows no activity (stall.ts)
//   limited    running tasks whose session's account is at its usage limit (limit.ts)
//   offline    running tasks whose session dropped (model.ts reachOf 'gone')
// A task counts once, under its strongest reason (model.ts attentionOf). A task waiting on a
// question is left to `questions`, so the question is not counted twice.
export type WaitCount = { questions: number; approvals: number; stalled: number; limited: number; offline: number; total: number }

export const NO_WAIT: WaitCount = { questions: 0, approvals: 0, stalled: 0, limited: 0, offline: 0, total: 0 }

export function waitCount(
  state: { questions: readonly Pick<Question, 'status'>[]; approvals?: readonly Pick<Approval, 'status'>[]; tasks: readonly Task[] },
  attention: (task: Task) => Attention | null,
): WaitCount {
  const count: WaitCount = { ...NO_WAIT }
  count.questions = state.questions.filter(q => q.status === 'pending').length
  count.approvals = (state.approvals ?? []).filter(a => a.status === 'pending').length
  for (const task of state.tasks) {
    const why = attention(task)
    if (why === 'stalled' || why === 'limited' || why === 'offline') count[why] += 1
  }
  count.total = count.questions + count.approvals + count.stalled + count.limited + count.offline
  return count
}

const PARTS: [Exclude<keyof WaitCount, 'total'>, Key][] = [
  ['questions', 'wait.questions'],
  ['approvals', 'wait.approvals'],
  ['stalled', 'wait.stalled'],
  ['limited', 'wait.limited'],
  ['offline', 'wait.offline'],
]

// What the count is made of, the parts that are not zero: "결정 질문 2, 권한 확인 1".
export function waitParts(count: WaitCount): string {
  return PARTS.filter(([part]) => count[part] > 0)
    .map(([part, key]) => t(key, { n: count[part] }))
    .join(', ')
}
