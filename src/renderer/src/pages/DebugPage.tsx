import { useEffect, useRef } from 'react'
import type { Session } from '../../../shared/types'
import { BrowserView } from '../BrowserView'
import { debugStore, openAction, waitUntilAnswering, type OpenEvent } from '../debugStore'

const HANDLED_KEY = 'claude-ide:debug-open'
const LIVE_MS = 5000
// A request older than this was meant for an earlier sitting.
const OPEN_FRESH_MS = 2 * 60_000

function handledId(): string {
  try {
    return localStorage.getItem(HANDLED_KEY) ?? ''
  } catch {
    return ''
  }
}

// Dynamic debugging: the browser with comment mode, plus what reaches it from
// the bridge: sessions that are alive, and pages a session asks to open
// (open_in_ide). Dev server control lands in DebugPanel.
export function DebugPage({
  sessions,
  visible,
  scope,
  lan,
  onShow,
}: {
  sessions: Session[]
  visible: boolean
  scope?: string | null
  lan?: boolean
  onShow?: () => void
}) {
  const showRef = useRef(onShow)
  showRef.current = onShow

  useEffect(() => {
    const readLive = async () => {
      const reply = await window.ideDebug.call('GET', '/sessions/live')
      if (reply.ok && Array.isArray(reply.json.ids)) debugStore.setLive(reply.json.ids as string[])
    }
    let handled = handledId()
    const handle = async (event: OpenEvent | null | undefined) => {
      if (!event || event.id === handled || Date.now() - event.at > OPEN_FRESH_MS) return
      handled = event.id
      try {
        localStorage.setItem(HANDLED_KEY, event.id)
      } catch {
        // per-viewer convenience only
      }
      showRef.current?.()
      // Comments on this page go back to the session that asked for it.
      if (event.sessionId) debugStore.setSession(event.sessionId)
      const target = event.target
      if (!target) return debugStore.openUrl(event.url)
      debugStore.setTarget(target.id)
      const status = await window.ide.devStatus(target)
      if (openAction(event, status) === 'open') return debugStore.openUrl(event.url)
      const ran = await window.ide.devRestart(target)
      if (ran.ok) await waitUntilAnswering(target)
      // Opened either way: a server that did not answer shows the error page.
      debugStore.openUrl(event.url, true)
    }
    const readOpen = async () => {
      const reply = await window.ideDebug.call('GET', '/dev/open')
      if (reply.ok) await handle(reply.json.open as OpenEvent | null)
    }
    void readLive()
    void readOpen()
    const timer = setInterval(() => void readLive(), LIVE_MS)
    const off = window.ide.onChange(event => {
      if (event.type === 'devOpen') void handle((event as { open?: OpenEvent }).open)
      if (event.type === 'sessions') void readLive()
      if (event.type === 'connected') {
        void readLive()
        void readOpen()
      }
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [])

  return <BrowserView sessions={sessions} visible={visible} scope={scope} lan={lan} onShow={onShow} />
}
