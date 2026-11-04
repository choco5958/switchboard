import { SEND_DELAY_MS, queueAnswer, takeBack } from './outbox'
import type { ShowToast } from './parts'
import { t } from '../../shared/i18n'

// Sends an answer the way every place that answers does: it waits SEND_DELAY_MS in the app
// (outbox.ts) while the toast offers Undo, then goes; the toast says when it has gone or why it
// could not; an answer that could not go waits on the question's card to send again. onUndo: what
// to show again once Undo took it back (the question, where it was asked).
export function sendAnswer(id: number, choice: string, memo: string, toast: ShowToast, onUndo?: () => void): void {
  queueAnswer(id, { choice, memo }, async () => {
    let error: string
    try {
      const reply = await window.ide.answer(id, choice, memo)
      if (reply.ok) {
        toast(t('question.sent', { id }))
        return true
      }
      error = String(reply.json.error ?? t('question.sendFailed'))
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    toast(t('question.sendFailedId', { id, error }), 'bad')
    return false
  })
  const undo = () => {
    if (!takeBack(id)) return
    toast(t('question.undone', { id }), 'info')
    onUndo?.()
  }
  toast(t('question.sending', { id, s: SEND_DELAY_MS / 1000 }), 'info', { label: t('common.undo'), run: undo }, SEND_DELAY_MS)
}
