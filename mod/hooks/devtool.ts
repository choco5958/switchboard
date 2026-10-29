import type { EngineInterface as Engine, On } from 'claude-code'
import { currentLang, sessionLang, t } from './i18n.ts'
import { bridgeFetch } from './link.ts'
import { openBody, openResultText, openToolDef, type OpenArgs, type Reply } from './tools.ts'

export { openBody, openResultText, type OpenArgs }

// open_in_ide: the person asks the session in words ("검수 앱 8951 열어줘") and
// the session opens that page in the IDE's dynamic debugging tab. The bridge
// registers or updates the dev target; the IDE starts the server when needed.

export const OPEN_TOOL = 'open_in_ide'

async function post($: Engine, path: string, body: unknown): Promise<Reply> {
  const res = await bridgeFetch($, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json: Record<string, unknown> = {}
  try {
    json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {}
  } catch {
    json = { error: res.text }
  }
  return { ok: res.ok, status: res.status, json }
}

export function registerDevtool(on: On): void {
  // register.ts holds the plain session.start hook; this one is for the sessions
  // a person works in, the only ones that ask to see a page.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({ ...openToolDef(await sessionLang($), OPEN_TOOL), isDeferred: false })
    return started
  })

  on('tool.call', { tool: `mcp__ide-bridge__${OPEN_TOOL}` }, async ($, e) => {
    const body = openBody(e as OpenArgs, await $.session.id(), await $.session.root())
    const reply = await post($, '/dev/open', body).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
    return { result: openResultText(reply, currentLang()) }
  }).catch(() => ({ result: t(currentLang(), 'dev.unreachable') }))
}
