// Answering the decision queue from a phone, through the person's own Telegram bot.
//
// The bridge polls Telegram (getUpdates, long polling): nothing listens on a port, and no
// relay of ours sits between. The bot talks to one chat only, the one that sent
// `/start <code>` with the one-time code the app showed; every button press and reply from
// anyone else is refused. A question goes out only while the person is away from the desk
// (the app closed, the screen locked, or no keyboard and mouse for five minutes); when it
// is answered anywhere, the Telegram message is edited to say so and loses its buttons.
// Telegram's servers see what is sent: values that look like credentials are masked.

import { randomInt } from 'node:crypto'
import { maskSecrets } from '../src/shared/pageLog.ts'
import { tIn, type Lang } from '../src/shared/i18n/index.ts'

export const TELEGRAM_API = 'https://api.telegram.org'
const PAIR_MS = 10 * 60_000
const POLL_SECONDS = 25

export type TelegramQuestion = {
  id: number
  session_id: string
  project: string
  task_title: string
  question: string
  body: string
  options: string
  recommend: string
  status: string
}

export type TelegramDeps = {
  api: string
  fetch: typeof fetch
  secret: (key: string) => string | null
  setSecret: (key: string, value: string | null) => void
  lang: () => Lang
  away: () => boolean
  // Questions waiting for an answer, oldest first.
  pending: () => TelegramQuestion[]
  question: (id: number) => TelegramQuestion | undefined
  answer: (id: number, choice: string | null, memo: string | null) => void
  hold: (id: number) => void
  // The Telegram message each question went out as (kept in the bridge's database).
  sentMessage: (questionId: number) => number | null
  saveMessage: (questionId: number, messageId: number) => void
  questionOf: (messageId: number) => number | null
  changed: () => void
  log: (text: string) => void
}

type Update = {
  update_id: number
  message?: { message_id: number; chat: { id: number; type: string; first_name?: string; username?: string }; from?: { id: number }; text?: string; reply_to_message?: { message_id: number } }
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }
}

function options(q: TelegramQuestion): { key: string; label: string }[] {
  try {
    const list = JSON.parse(q.options || '[]') as unknown
    return Array.isArray(list) ? (list as { key: string; label: string }[]) : []
  } catch {
    return []
  }
}

// The message a question goes out as, and its buttons: one per option, then hold.
export function questionMessage(q: TelegramQuestion, lang: Lang): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  const opts = options(q)
  const lines = [`[${q.task_title || q.project}] Q${q.id}`, q.question]
  if (q.body) lines.push('', q.body.length > 800 ? `${q.body.slice(0, 799)}…` : q.body)
  if (opts.length > 0) lines.push('')
  for (const o of opts) lines.push(`(${o.key}) ${o.label}${o.key === q.recommend ? ` ${tIn(lang, 'telegram.recommended')}` : ''}`)
  lines.push('', tIn(lang, 'telegram.howTo'))
  const keyboard = opts.map(o => [{ text: `(${o.key}) ${o.label}`.slice(0, 60), callback_data: `a:${q.id}:${o.key}` }])
  keyboard.push([{ text: tIn(lang, 'telegram.hold'), callback_data: `h:${q.id}` }])
  return { text: maskSecrets(lines.join('\n')), keyboard }
}

// What the person typed in reply: an option key first ("a", "(a) 이유") picks it; the rest is the memo.
export function replyAnswer(text: string, keys: readonly string[]): { choice: string | null; memo: string | null } {
  const match = text.trim().match(/^[([]?\s*([A-Za-z0-9])\s*[)\].:,]?(?:\s+([\s\S]*))?$/)
  const key = match ? keys.find(k => k.toLowerCase() === match[1]!.toLowerCase()) : undefined
  if (key) return { choice: key, memo: match![2]?.trim() || null }
  return { choice: null, memo: text.trim() || null }
}

export function createTelegram(deps: TelegramDeps) {
  let running = false
  let abort: AbortController | null = null
  let offset = 0
  let bot = ''
  let pairCode = ''
  let pairUntil = 0

  const token = () => deps.secret('telegram.token')
  const chat = () => Number(deps.secret('telegram.chat')) || 0
  const user = () => Number(deps.secret('telegram.user')) || 0

  const call = async (method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
    const key = token()
    if (!key) throw new Error('no token')
    const res = await deps.fetch(`${deps.api}/bot${key}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string }
    if (!json.ok) throw new Error(json.description ?? `${method} failed`)
    return json.result
  }

  const say = (key: Parameters<typeof tIn>[1], vars?: Record<string, string | number>) => tIn(deps.lang(), key, vars)

  // A question goes out once, while the person is away and a chat is paired.
  const send = async (q: TelegramQuestion) => {
    if (!chat() || !deps.away() || deps.sentMessage(q.id) !== null || q.status === 'answered') return
    const { text, keyboard } = questionMessage(q, deps.lang())
    const sent = (await call('sendMessage', { chat_id: chat(), text, reply_markup: { inline_keyboard: keyboard } })) as { message_id: number }
    deps.saveMessage(q.id, sent.message_id)
  }

  const sendPending = async () => {
    for (const q of deps.pending()) await send(q).catch(error => deps.log(`telegram send: ${String(error)}`))
  }

  const closeMessage = async (questionId: number, text: string) => {
    const messageId = deps.sentMessage(questionId)
    if (!messageId || !chat()) return
    await call('editMessageText', { chat_id: chat(), message_id: messageId, text }).catch(error => deps.log(`telegram edit: ${String(error)}`))
  }

  const answeredText = (q: TelegramQuestion, choice: string | null, memo: string | null, where: 'telegram' | 'elsewhere') => {
    const picked = options(q).find(o => o.key === choice)
    const what = choice ? `(${choice}) ${picked?.label ?? ''}`.trim() : say('telegram.memoOnly')
    return maskSecrets(
      [`[${q.task_title || q.project}] Q${q.id}`, q.question, '', say(where === 'telegram' ? 'telegram.answeredHere' : 'telegram.answeredElsewhere', { what }), memo ? memo : '']
        .filter((line, i, all) => !(i === all.length - 1 && line === ''))
        .join('\n'),
    )
  }

  const handle = async (update: Update) => {
    const message = update.message
    if (message?.text?.startsWith('/start')) {
      const code = message.text.split(/\s+/)[1] ?? ''
      if (message.chat.type !== 'private') return
      if (!pairCode || code !== pairCode || Date.now() > pairUntil) {
        await call('sendMessage', { chat_id: message.chat.id, text: say('telegram.badCode') })
        return
      }
      pairCode = ''
      deps.setSecret('telegram.chat', String(message.chat.id))
      deps.setSecret('telegram.user', String(message.from?.id ?? message.chat.id))
      deps.setSecret('telegram.name', message.chat.first_name ?? message.chat.username ?? '')
      deps.changed()
      await call('sendMessage', { chat_id: message.chat.id, text: say('telegram.paired') })
      await sendPending()
      return
    }
    if (message?.reply_to_message && message.text && message.from?.id === user() && message.chat.id === chat()) {
      const questionId = deps.questionOf(message.reply_to_message.message_id)
      const q = questionId === null ? undefined : deps.question(questionId)
      if (!q) return
      if (q.status === 'answered') {
        await call('sendMessage', { chat_id: chat(), text: say('telegram.already', { id: q.id }), reply_to_message_id: message.message_id })
        return
      }
      const { choice, memo } = replyAnswer(message.text, options(q).map(o => o.key))
      deps.answer(q.id, choice, memo)
      await closeMessage(q.id, answeredText(q, choice, memo, 'telegram'))
      return
    }
    const press = update.callback_query
    if (press) {
      if (press.from.id !== user() || press.message?.chat.id !== chat()) {
        await call('answerCallbackQuery', { callback_query_id: press.id, text: say('telegram.notYou') })
        return
      }
      const [kind, id, key] = (press.data ?? '').split(':')
      const q = deps.question(Number(id))
      if (!q || q.status === 'answered') {
        await call('answerCallbackQuery', { callback_query_id: press.id, text: say('telegram.already', { id: Number(id) }) })
        return
      }
      if (kind === 'h') {
        deps.hold(q.id)
        await call('answerCallbackQuery', { callback_query_id: press.id, text: say('telegram.held') })
        return
      }
      const choice = options(q).some(o => o.key === key) ? key! : null
      if (!choice) return
      deps.answer(q.id, choice, null)
      await call('answerCallbackQuery', { callback_query_id: press.id, text: say('telegram.sent') })
      await closeMessage(q.id, answeredText(q, choice, null, 'telegram'))
    }
  }

  const loop = async () => {
    let wait = 0
    while (running && token()) {
      abort = new AbortController()
      try {
        const updates = (await call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }, abort.signal)) as Update[]
        wait = 0
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1)
          await handle(update).catch(error => deps.log(`telegram update: ${String(error)}`))
        }
      } catch (error) {
        if (!running) return
        deps.log(`telegram poll: ${String(error)}`)
        wait = Math.min(Math.max(wait * 2, 5000), 60_000)
        await new Promise(resolve => setTimeout(resolve, wait))
      }
    }
  }

  const start = () => {
    if (running || !token()) return
    running = true
    void loop().finally(() => {
      running = false
    })
  }

  const stop = () => {
    running = false
    abort?.abort()
  }

  return {
    start,
    stop,
    // A new question: out at once when away.
    posted: (q: TelegramQuestion) => void send(q).catch(error => deps.log(`telegram send: ${String(error)}`)),
    // Answered somewhere else (the app, the shell, another session): the message says so.
    answeredElsewhere: (q: TelegramQuestion, choice: string | null, memo: string | null) => void closeMessage(q.id, answeredText(q, choice, memo, 'elsewhere')),
    // The person left the desk: what waits goes out.
    away: () => void sendPending(),
    status: () => ({ configured: token() !== null, bot, paired: chat() !== 0, name: deps.secret('telegram.name') ?? '', code: Date.now() < pairUntil ? pairCode : '', codeUntil: pairUntil }),
    // A token is checked with getMe before it is kept; null forgets the bot and the chat.
    setToken: async (value: string | null) => {
      stop()
      if (value === null) {
        for (const key of ['telegram.token', 'telegram.chat', 'telegram.user', 'telegram.name']) deps.setSecret(key, null)
        bot = ''
        return { ok: true as const }
      }
      const previous = token()
      deps.setSecret('telegram.token', value)
      try {
        const me = (await call('getMe', {})) as { username: string }
        bot = me.username
        start()
        return { ok: true as const, bot }
      } catch (error) {
        deps.setSecret('telegram.token', previous)
        if (previous) start()
        return { ok: false as const, error: String(error instanceof Error ? error.message : error) }
      }
    },
    pair: async () => {
      if (!bot && token()) bot = ((await call('getMe', {}).catch(() => ({ username: '' }))) as { username: string }).username
      pairCode = String(randomInt(100000, 1000000))
      pairUntil = Date.now() + PAIR_MS
      return { code: pairCode, link: bot ? `https://t.me/${bot}?start=${pairCode}` : '' }
    },
    unpair: () => {
      for (const key of ['telegram.chat', 'telegram.user', 'telegram.name']) deps.setSecret(key, null)
    },
    test: () => call('sendMessage', { chat_id: chat(), text: say('telegram.test') }),
  }
}
