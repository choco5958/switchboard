import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { Session } from '../../shared/types'
import { portOf, targetsOf, type DevTarget } from '../../shared/devtargets'
import {
  COMMENT_STATUSES,
  commentBody,
  commentPrompt,
  countByStatus,
  filterComments,
  pageKey,
  shortTime,
  type Comment,
  type CommentFilter,
} from './comments'
import { debugStore, failureReason, sessionFor, useDebugStore, waitUntilAnswering, whereTo } from './debugStore'
import { CaptureLimiter, makeNonce, parseMessage, pickerSource, type PickMessage } from './picker'
import { commentStatusLabel, t, type Key } from '../../shared/i18n'
import { composing } from './ime'
import { consoleEntry, logText, pushEntry, type PageLogEntry } from '../../shared/pageLog'
import { focusScript, isLocalUrl, pointScript, refRevision, snapshotScript, snapshotText, type Snapshot } from './agentBrowser'

const URL_KEY = 'claude-ide:browser-url'
const SHOT_PAD = 24
// Chromium's "aborted": a new navigation replaced the one that failed.
const ABORTED = -3

const HEADINGS: Record<CommentFilter, Key> = { 열림: 'browser.headOpen', 보냄: 'browser.headSent', 해결: 'browser.headResolved', 전체: 'browser.headAll' }
const EMPTY: Record<Exclude<CommentFilter, '열림'>, Key> = {
  보냄: 'browser.emptySent',
  해결: 'browser.emptyResolved',
  전체: 'browser.emptyAll',
}

type Failure = { url: string; code: string }

function savedUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? 'http://127.0.0.1:3000/'
  } catch {
    return 'http://127.0.0.1:3000/'
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function hostPort(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${portOf(url) ?? ''}`
  } catch {
    return url
  }
}

const isToggle = (event: KeyboardEvent) => event.altKey && event.code === 'KeyM'

export function BrowserView({
  sessions,
  visible,
  scope,
  onShow,
}: {
  sessions: Session[]
  visible: boolean
  scope?: string | null
  onShow?: () => void
}) {
  const view = useRef<WebviewTag | null>(null)
  const debug = useDebugStore()
  const [address, setAddress] = useState(savedUrl)
  const [src, setSrc] = useState(savedUrl)
  const [page, setPage] = useState(savedUrl) // the address the page really shows
  const [title, setTitle] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [failedTarget, setFailedTarget] = useState<DevTarget | null>(null)
  const [starting, setStarting] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [filter, setFilter] = useState<CommentFilter>('열림')
  const [status, setStatus] = useState('')
  // Picks waiting for their memo in the page popover, by the page's pick id.
  const picks = useRef(new Map<number, Promise<{ pick: PickMessage; shot: string | null }>>())
  // A fresh nonce for every injection; page messages without it are ignored.
  const nonce = useRef('')
  // Console warnings and errors and failed requests of the page shown now, for its comments.
  const pageLog = useRef<PageLogEntry[]>([])
  const limiter = useRef(new CaptureLimiter())
  const commentingRef = useRef(commenting)
  commentingRef.current = commenting
  const openComments = comments.filter(c => c.status === '열림')
  const openRef = useRef(openComments)
  openRef.current = openComments
  const pageRef = useRef(page)
  pageRef.current = page
  // Webview methods throw (synchronously) until its first dom-ready.
  const ready = useRef(false)
  const latest = useRef('')
  // Every script runs in a world of its own: the page shares the DOM with it but cannot
  // replace the functions it calls (getBoundingClientRect, elementFromPoint, console.log)
  // or read the picker and its nonce.
  const run = (code: string) => {
    if (!ready.current || !view.current) return Promise.resolve(undefined)
    return window.ideDebug.run(view.current.getWebContentsId(), code).catch(() => undefined)
  }
  const marksCode = () =>
    `window.__claudeIde && window.__claudeIde.marks(${JSON.stringify(openRef.current.map((c, i) => ({ n: i + 1, selector: c.css, url: c.url })))})`

  // The newest live session of the chosen project, unless one was picked in the sidebar.
  const target = sessionFor(debug.session, sessions, scope, debug.live)
  const targetId = target?.id ?? ''
  const targetIdRef = useRef(targetId)
  targetIdRef.current = targetId

  const loadComments = useCallback(async (url: string) => {
    const reply = await window.ideDebug.call('GET', `/comments?url=${encodeURIComponent(pageKey(url))}`)
    if (reply.ok && pageKey(url) === pageKey(pageRef.current)) setComments((reply.json.comments as Comment[]) ?? [])
  }, [])

  useEffect(() => {
    void loadComments(page)
    const off = window.ide.onChange(event => {
      if (event.type === 'comments' || event.type === 'connected') void loadComments(pageRef.current)
    })
    return off
  }, [page, loadComments])

  const load = (raw: string) => {
    const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`
    // loadURL throws until the first dom-ready (a dev server that was down at
    // start leaves an error page, which still counts); before that the first
    // load is still under way, so the address goes to the src it loads.
    const wv = view.current
    if (!wv) return
    setStatus('')
    setAddress(url)
    if (ready.current) void wv.loadURL(url).catch(() => undefined)
    else setSrc(url)
  }

  useEffect(() => {
    const wv = view.current
    if (!wv) return
    const inject = () => {
      ready.current = true
      const previous = nonce.current
      const next = makeNonce()
      nonce.current = next
      limiter.current.reset()
      picks.current.clear()
      void run(pickerSource(next))
        .then(result => {
          // A document that already has a picker keeps talking with the nonce it was given.
          if (result === 'kept' && nonce.current === next) nonce.current = previous
        })
        .then(() => run(`window.__claudeIde && window.__claudeIde.set(${commentingRef.current})`))
        .then(() => run(marksCode()))
    }
    const onConsole = (event: Event) => {
      const raw = event as unknown as { message: string; level: unknown; sourceId?: string; line?: number }
      const message = parseMessage(raw.message, nonce.current)
      if (!message) {
        pageLog.current = pushEntry(pageLog.current, consoleEntry(Date.now(), raw.level, raw.message, raw.sourceId, raw.line))
        return
      }
      if (message.kind === 'exit') return setCommenting(false)
      if (message.kind === 'toggle') return setCommenting(on => !on)
      if (message.kind === 'cancel') {
        picks.current.delete(message.id)
        return
      }
      if (message.kind === 'save') {
        const picked = picks.current.get(message.id)
        picks.current.delete(message.id)
        if (!picked) return
        void picked.then(async ({ pick, shot }) => {
          const reply = await window.ideDebug.call('POST', '/comments', commentBody(pick, message.memo, shot, targetIdRef.current, logText(pageLog.current)))
          if (!reply.ok) setStatus(t('browser.saveFailed', { error: String(reply.json.error ?? '') }))
          setFilter('열림')
          await loadComments(pageRef.current)
        })
        return
      }
      // A pick counts only in comment mode, and shots are rate-limited.
      if (!commentingRef.current) return
      if (!limiter.current.allow(Date.now())) {
        setStatus(t('browser.tooFast'))
        return
      }
      const pick = message.pick
      const r = pick.rect
      const x = Math.max(0, Math.floor(r.x - SHOT_PAD))
      const y = Math.max(0, Math.floor(r.y - SHOT_PAD))
      const shot = wv
        .capturePage({ x, y, width: Math.ceil(r.width + SHOT_PAD * 2), height: Math.ceil(r.height + SHOT_PAD * 2) })
        .then(image => window.ide.saveShot(image.toDataURL()))
        .catch(() => null)
        .then(file => ({ pick, shot: file ?? null }))
      // The page keeps one memo open at a time, so older picks are done.
      picks.current.clear()
      picks.current.set(pick.id, shot)
      // The popover opens after the shot, so it is not in the picture.
      void shot.then(() => run(`window.__claudeIde.ask(${pick.id})`))
    }
    const offNet = window.ideDebug.onNet(({ webContentsId, entry }) => {
      if (ready.current && webContentsId === wv.getWebContentsId()) pageLog.current = pushEntry(pageLog.current, entry)
    })
    const onNavigate = (event: Event) => {
      const url = (event as unknown as { url: string }).url
      setAddress(url)
      setPage(url)
      setStatus('')
      try {
        localStorage.setItem(URL_KEY, url)
      } catch {
        // per-viewer convenience only
      }
    }
    const onStart = () => setFailure(null)
    // The newest main-frame navigation: a failure of one it replaced is old news.
    const onStartNavigation = (event: Event) => {
      const { url, isMainFrame, isInPlace } = event as unknown as { url: string; isMainFrame: boolean; isInPlace: boolean }
      if (!isMainFrame || isInPlace) return
      latest.current = url
      // A new document starts a new log; a route change inside the page keeps it.
      pageLog.current = []
    }
    const onTitle = (event: Event) => setTitle((event as unknown as { title: string }).title)
    const onFail = (event: Event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = event as unknown as {
        errorCode: number
        errorDescription: string
        validatedURL: string
        isMainFrame: boolean
      }
      if (!isMainFrame || errorCode === ABORTED || (latest.current && validatedURL !== latest.current)) return
      setFailure({ url: validatedURL, code: errorDescription || t('browser.errorCode', { code: errorCode }) })
      setPage(validatedURL)
      setTitle('')
    }
    wv.addEventListener('did-fail-load', onFail)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-start-navigation', onStartNavigation)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('dom-ready', inject)
    wv.addEventListener('console-message', onConsole)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      offNet()
      wv.removeEventListener('did-fail-load', onFail)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-start-navigation', onStartNavigation)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('dom-ready', inject)
      wv.removeEventListener('console-message', onConsole)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [])

  useEffect(() => {
    void run(`window.__claudeIde && window.__claudeIde.set(${commenting})`)
  }, [commenting])

  useEffect(() => {
    void run(marksCode())
  }, [comments])

  // The error page offers to start the dev server that serves this address.
  useEffect(() => {
    setFailedTarget(null)
    if (!failure) return
    void window.ide.state().then(state => {
      const port = portOf(failure.url)
      const host = hostPort(failure.url)
      setFailedTarget(targetsOf(state?.settings.devTargets).find(t => t.port === port && hostPort(t.url) === host) ?? null)
    })
  }, [failure?.url])

  // The sidebar (or open_in_ide) asks to open a url.
  // After a restart it reloads past the cache, staying on the current page when
  // that is on the same server.
  useEffect(() => {
    const open = debug.open
    if (!open) return
    const wv = view.current
    if (open.fresh && wv && ready.current && !failure && sameOrigin(wv.getURL(), open.url)) {
      setStatus('')
      wv.reloadIgnoringCache()
    } else load(open.url)
  }, [debug.open?.seq])

  // A session drives this browser (browser_* tools, src/renderer/src/agentBrowser.ts). The tab
  // comes to the front, so the person sees what it does, and so the page has a size to act in.
  const revision = useRef(0)
  const showRef = useRef(onShow)
  showRef.current = onShow
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const snapshot = async (): Promise<string> => {
      revision.current += 1
      const read = (await run(snapshotScript(revision.current))) as Snapshot | undefined
      if (!read) throw new Error('the page cannot be read yet')
      // Checked again after every move: a redirect or a link may have left the local pages.
      if (!isLocalUrl(read.url)) throw new Error('the page is no longer local (a redirect or a link left it); open a local page with browser_navigate')
      return snapshotText(read)
    }
    const element = (ref: unknown) => {
      const value = String(ref ?? '')
      if (refRevision(value) !== revision.current) throw new Error(`ref ${value} is from an older reading; call browser_snapshot again`)
      return value
    }
    const act = async (action: string, args: Record<string, unknown>): Promise<{ text?: string; path?: string }> => {
      const wv = view.current
      if (!wv) throw new Error('the browser is not ready')
      if (commentingRef.current) throw new Error('the person is leaving screen comments in this browser now; try again later')
      if (action === 'navigate') {
        const url = String(args.url ?? '')
        if (!isLocalUrl(url)) throw new Error('only local pages (localhost, 127.0.0.1, the private network) can be opened')
        const stopped = new Promise<void>(resolve => {
          const done = () => {
            wv.removeEventListener('did-stop-loading', done)
            resolve()
          }
          wv.addEventListener('did-stop-loading', done)
        })
        loadRef.current(url)
        await Promise.race([stopped, settle(10_000)])
        await settle(300)
        return { text: await snapshot() }
      }
      if (!isLocalUrl(pageRef.current)) throw new Error('the browser shows a page that is not local; open a local page with browser_navigate first')
      if (action === 'snapshot') return { text: await snapshot() }
      if (action === 'console') return { text: logText(pageLog.current) || 'no console warnings, errors or failed requests on this page' }
      if (action === 'screenshot') {
        const image = await wv.capturePage()
        const path = await window.ide.saveShot(image.toDataURL())
        if (!path) throw new Error('the screenshot could not be saved')
        return { path, text: path }
      }
      if (action === 'click') {
        const point = (await run(pointScript(element(args.ref)))) as { x?: number; y?: number; error?: string; by?: string } | undefined
        if (!point || point.error === 'stale') throw new Error('that element is gone; call browser_snapshot again')
        if (point.error === 'covered') throw new Error(`the element is covered by ${point.by}`)
        const at = { x: point.x!, y: point.y! }
        wv.sendInputEvent({ type: 'mouseMove', ...at })
        wv.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
        wv.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
        await settle(600)
        return { text: await snapshot() }
      }
      if (action === 'type') {
        const focused = (await run(focusScript(element(args.ref)))) as { error?: string } | undefined
        if (!focused || focused.error) throw new Error('that element is gone; call browser_snapshot again')
        await wv.insertText(String(args.text ?? ''))
        if (args.submit === true) {
          wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          wv.sendInputEvent({ type: 'char', keyCode: '\r' })
          wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        }
        await settle(500)
        return { text: await snapshot() }
      }
      throw new Error(`unknown action: ${action}`)
    }
    return window.ide.onChange(event => {
      if (event.type !== 'browserAct') return
      const { id, action, args } = (event as unknown as { act: { id: string; action: string; args: Record<string, unknown> } }).act
      showRef.current?.()
      void settle(150)
        .then(() => act(action, args ?? {}))
        .then(
          result => window.ideDebug.call('POST', '/browser/result', { id, ...result }),
          (error: unknown) => window.ideDebug.call('POST', '/browser/result', { id, error: error instanceof Error ? error.message : String(error) }),
        )
    })
  }, [])

  // ⌥M while the IDE (not the page) has focus; the page has its own listener.
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      // Keys typed into a dock terminal belong to the program running there.
      if ((event.target as HTMLElement | null)?.closest?.('.terminal-view')) return
      if (isToggle(event)) {
        event.preventDefault()
        setCommenting(on => !on)
      } else if (event.key === 'Escape' && commentingRef.current) setCommenting(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  const setStatusOf = async (list: Comment[], next: (typeof COMMENT_STATUSES)[number], sessionId = '') => {
    const reply = await window.ideDebug.call('POST', '/comments/status', { ids: list.map(c => c.id), status: next, sessionId })
    if (!reply.ok) setStatus(t('browser.changeFailed', { error: String(reply.json.error ?? '') }))
    await loadComments(pageRef.current)
    return reply.ok
  }

  const remove = async (comment: Comment) => {
    await window.ideDebug.call('POST', `/comments/${comment.id}/delete`)
    await loadComments(pageRef.current)
  }

  // Sending keeps the comments, marked 보냄, so the page still shows what went out.
  const sendAll = async () => {
    const list = openRef.current
    if (!target || list.length === 0) return
    const reply = await window.ide.send(target.id, commentPrompt(list), '화면 코멘트', '')
    if (!reply.ok) return setStatus(t('linear.sendFailed', { error: String(reply.json.error ?? '') }))
    await setStatusOf(list, '보냄', target.id)
    setStatus(t('browser.sent', { n: list.length }))
    setCommenting(false)
  }

  const startFailed = async (devTarget: DevTarget) => {
    setStarting(true)
    try {
      debugStore.setTarget(devTarget.id)
      const result = await window.ide.devRestart(devTarget)
      if (!result.ok) return setStatus(result.out)
      await waitUntilAnswering(devTarget)
      debugStore.openUrl(failure?.url ?? devTarget.url, true)
    } finally {
      setStarting(false)
    }
  }

  const counts = countByStatus(comments)
  const shown = filterComments(comments, filter)

  return (
    <div className={`browser ${visible ? '' : 'browser-hidden'}`}>
      <div className="browser-bar">
        <button title={t('browser.back')} onClick={() => ready.current && view.current?.goBack()}>
          &lt;
        </button>
        <button title={t('browser.forward')} onClick={() => ready.current && view.current?.goForward()}>
          &gt;
        </button>
        <button title={t('browser.reload')} onClick={() => ready.current && view.current?.reload()}>
          {t('browser.reload')}
        </button>
        <input
          className="address"
          value={address}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && !composing(event) && load(address)}
        />
        <button
          className={`switch ${commenting ? 'switch-on' : ''}`}
          role="switch"
          aria-checked={commenting}
          title={t('browser.commentModeTitle')}
          onClick={() => setCommenting(on => !on)}
        >
          <span className="switch-track">
            <span className="switch-knob" />
          </span>
          {t('browser.commentMode')} <kbd>⌥M</kbd>
        </button>
        <button className="primary" disabled={openComments.length === 0 || !targetId} onClick={() => void sendAll()}>
          {t('browser.sendToClaude')}{openComments.length > 0 ? ` (${openComments.length})` : ''}
        </button>
      </div>
      <div className="browser-body">
        <div className="webview-wrap">
          <webview ref={view} src={src} partition="persist:claude-ide" className="webview" />
          {failure && (
            <div className="load-failure" role="alert">
              <div className="load-failure-box">
                <h2>{t('browser.loadFailed')}</h2>
                <p className="mono load-failure-url">{failure.url}</p>
                <p>{failureReason(failure.code)}</p>
                <p className="quiet small mono">{failure.code}</p>
                <div className="actions">
                  <button className="primary" onClick={() => load(failure.url)}>
                    {t('browser.retry')}
                  </button>
                  {failedTarget ? (
                    <button disabled={starting} onClick={() => void startFailed(failedTarget)}>
                      {starting ? t('browser.starting') : t('browser.start', { name: failedTarget.name })}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        debugStore.requestTarget(failure.url)
                        onShow?.()
                      }}
                    >
                      {t('browser.addTarget')}
                    </button>
                  )}
                </div>
                <p className="quiet small">
                  {failedTarget
                    ? t('browser.targetHint', { name: failedTarget.name })
                    : t('browser.noTargetHint')}
                </p>
              </div>
            </div>
          )}
        </div>
        <aside className="comment-panel">
          <div className="comment-head">
            <h2>{t(HEADINGS[filter])}</h2>
            <select className="comment-filter" value={filter} title={t('browser.filterTitle')} onChange={event => setFilter(event.target.value as CommentFilter)}>
              {(['열림', '보냄', '해결', '전체'] as CommentFilter[]).map(f => (
                <option key={f} value={f}>
                  {commentStatusLabel(f)} {counts[f]}
                </option>
              ))}
            </select>
          </div>
          {shown.length === 0 && (
            <p className="quiet small">
              {filter !== '열림'
                ? t(EMPTY[filter])
                : commenting
                  ? t('browser.emptyCommenting')
                  : t('browser.emptyOpen')}
            </p>
          )}
          {shown.map(c => {
            const n = openComments.indexOf(c)
            return (
              <div key={c.id} className={`kept kept-${c.status}`}>
                <div className="kept-head">
                  {n >= 0 ? <span className="mark-num">{n + 1}</span> : <span className="tag-chip kept-status">{commentStatusLabel(c.status)}</span>}
                  <span className="small quiet kept-where">{c.place || c.element}</span>
                </div>
                <div className="kept-text">{c.text}</div>
                <div className="kept-meta small quiet">
                  <span>{shortTime(c.status === '보냄' && c.sent_at ? c.sent_at : c.resolved_at ?? c.created_at)}</span>
                  {c.status === '보냄' && c.session_id && <span>{t('browser.sentTo', { id: c.session_id.slice(0, 8) })}</span>}
                  {c.shot && <span>{t('browser.shotAttached')}</span>}
                </div>
                <div className="kept-actions">
                  {c.status !== '해결' && (
                    <button className="link small" title={t('browser.resolveTitle')} onClick={() => void setStatusOf([c], '해결')}>
                      {t('commentStatus.resolved')}
                    </button>
                  )}
                  {c.status !== '열림' && (
                    <button className="link small" title={t('browser.reopenTitle')} onClick={() => void setStatusOf([c], '열림')}>
                      {t('browser.reopen')}
                    </button>
                  )}
                  <button className="link small" title={t('browser.deleteTitle')} onClick={() => void remove(c)}>
                    {t('dev.delete')}
                  </button>
                </div>
              </div>
            )
          })}

          <p className="small comment-target">
            <span className="quiet">{t('browser.sendTo')} </span>
            {target ? whereTo(target) : t('dev.noLiveSession')}
          </p>
          <p className="quiet small">{t('browser.sendHint')}</p>
          {status && <p className="small">{status}</p>}
        </aside>
      </div>
      <div className="browser-status">
        <span className="status-part">
          <span className="quiet">{t('browser.address')}</span> <span className="mono-inline">{page}</span>
        </span>
        {title && !failure && <span className="status-part status-title">{title}</span>}
        {failure && <span className="status-part error">{t('browser.failedShort')}</span>}
        <button className={`status-mode ${commenting ? 'status-mode-on' : ''}`} title={t('browser.toggleTitle')} onClick={() => setCommenting(on => !on)}>
          {commenting ? t('browser.modeOn') : t('browser.modeOff')}
        </button>
      </div>
    </div>
  )
}
