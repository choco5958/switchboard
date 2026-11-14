import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { commentStatusLabel, commentStatusSlug, t, type Key } from '../../shared/i18n'
import { composing } from './ime'
import { Badge, Button, Card, Chip, EmptyState, IconButton, Input, Select, cx } from './ui'
import { consoleEntry, logText, pushEntry, type PageLogEntry } from '../../shared/pageLog'
import { fillScript, isLocalUrl, navigatedTo, pointScript, refRevision, refusal, snapshotScript, snapshotText, type Snapshot } from './agentBrowser'
import type { PageSurface, SurfaceEvents } from './pageSurface'
import { PageView } from './PageView'

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
  lan = false,
  onShow,
  servers,
  direct,
}: {
  sessions: Session[]
  visible: boolean
  scope?: string | null
  lan?: boolean // sessions may drive private network pages too (BROWSER_LAN_KEY)
  onShow?: () => void
  // The drawer's other parts (pages/DebugPanel.tsx): the dev servers, and a prompt typed to the session.
  servers?: ReactNode
  direct?: ReactNode
}) {
  // The page itself, once its shell has drawn it (PageView.tsx).
  const [surface, setSurface] = useState<PageSurface | null>(null)
  const view = useRef<PageSurface | null>(null)
  view.current = surface
  const debug = useDebugStore()
  // The page starts the first time the browser is shown (by the person, or by a session that
  // opens a page, which shows it first), not with the app: until then no page of the last
  // address runs hidden in the background.
  const [started, setStarted] = useState(visible)
  const on = started || visible
  useEffect(() => {
    if (visible) setStarted(true)
  }, [visible])
  const [address, setAddress] = useState(savedUrl)
  const [src, setSrc] = useState(savedUrl)
  const [page, setPage] = useState(savedUrl) // the address the page really shows
  const [title, setTitle] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [failedTarget, setFailedTarget] = useState<DevTarget | null>(null)
  const [starting, setStarting] = useState(false)
  const [commenting, setCommenting] = useState(false)
  // The drawer beside the page, or none: the page takes the whole width. It is a column, never a
  // popover, because the shell draws the page above the app (the Tauri build's child webview).
  const [drawer, setDrawer] = useState<'comments' | 'servers' | null>(null)
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
  // The drawer opens by itself where something needs it: comment mode on, the first open comment,
  // the error page asking for a dev server.
  useEffect(() => {
    if (commenting) setDrawer('comments')
  }, [commenting])
  const hasOpen = openComments.length > 0
  useEffect(() => {
    if (hasOpen) setDrawer(d => d ?? 'comments')
  }, [hasOpen])
  useEffect(() => {
    if (debug.addTarget) setDrawer('servers')
  }, [debug.addTarget?.seq])
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
    return view.current.run(code).catch(() => undefined)
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
    setStatus('')
    setAddress(url)
    if (wv && ready.current) void wv.load(url)
    else setSrc(url)
  }

  useEffect(() => {
    const wv = surface
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
    const onConsole: SurfaceEvents['console'] = raw => {
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
        .capture({ x, y, width: Math.ceil(r.width + SHOT_PAD * 2), height: Math.ceil(r.height + SHOT_PAD * 2) })
        .then(image => (image ? window.ide.saveShot(image) : null))
        .catch(() => null)
        .then(file => ({ pick, shot: file ?? null }))
      // The page keeps one memo open at a time, so older picks are done.
      picks.current.clear()
      picks.current.set(pick.id, shot)
      // The popover opens after the shot, so it is not in the picture.
      void shot.then(() => run(`window.__claudeIde.ask(${pick.id})`))
    }
    const onNavigate: SurfaceEvents['navigate'] = event => {
      const url = navigatedTo(event)
      if (url === null) return
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
    const onStartNavigation: SurfaceEvents['startNavigation'] = ({ url, isMainFrame, isInPlace }) => {
      if (!isMainFrame || isInPlace) return
      latest.current = url
      // A new document starts a new log; a route change inside the page keeps it.
      pageLog.current = []
    }
    const onTitle = (title: string) => setTitle(title)
    const onFail: SurfaceEvents['fail'] = ({ errorCode, errorDescription, validatedURL, isMainFrame }) => {
      if (!isMainFrame || errorCode === ABORTED || (latest.current && validatedURL !== latest.current)) return
      setFailure({ url: validatedURL, code: errorDescription || t('browser.errorCode', { code: errorCode }) })
      setPage(validatedURL)
      setTitle('')
    }
    return wv.on({
      fail: onFail,
      startLoading: onStart,
      startNavigation: onStartNavigation,
      title: onTitle,
      ready: inject,
      console: onConsole,
      navigate: onNavigate,
      net: entry => {
        if (ready.current) pageLog.current = pushEntry(pageLog.current, entry)
      },
    })
  }, [surface])

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
    if (open.fresh && wv && ready.current && !failure && sameOrigin(wv.url(), open.url)) {
      setStatus('')
      wv.reloadIgnoringCache()
    } else load(open.url)
  }, [debug.open?.seq])

  // A session drives this browser (browser_* tools, src/renderer/src/agentBrowser.ts). The tab
  // comes to the front, so the person sees what it does, and so the page has a size to act in.
  // Only these acts are held to local pages; the person's own browsing goes anywhere.
  const revision = useRef(0)
  const lanRef = useRef(lan)
  lanRef.current = lan
  const showRef = useRef(onShow)
  showRef.current = onShow
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const local = (url: string) => isLocalUrl(url, lanRef.current)
    const allowed = () =>
      lanRef.current
        ? 'this computer (localhost, 127.0.0.1) or the private network'
        : 'this computer (localhost, 127.0.0.1); private network addresses need the person to allow them in Settings > Agent CLIs'
    const snapshot = async (): Promise<string> => {
      revision.current += 1
      const read = (await run(snapshotScript(revision.current))) as Snapshot | undefined
      if (!read) throw new Error('the page cannot be read yet')
      // Checked again after every move: a redirect or a link may have left the local pages.
      if (!local(read.url)) throw new Error(`the page is no longer local (a redirect or a link left it); open a page on ${allowed()} with browser_navigate`)
      return snapshotText(read)
    }
    const element = (ref: unknown) => {
      const value = String(ref ?? '')
      if (refRevision(value) !== revision.current) throw new Error(`ref ${value} is from an older reading; call browser_snapshot again`)
      return value
    }
    const act = async (action: string, args: Record<string, unknown>): Promise<{ text?: string; path?: string }> => {
      // A browser shown for the first time just now is still loading its first page.
      for (let waited = 0; !(view.current && (ready.current || action === 'navigate')) && waited < 10_000; waited += 100) await settle(100)
      const wv = view.current
      if (!wv) throw new Error('the browser is not ready')
      if (commentingRef.current) throw new Error('the person is leaving screen comments in this browser now; try again later')
      if (action === 'navigate') {
        const url = String(args.url ?? '')
        if (!local(url)) throw new Error(`only pages on ${allowed()} can be opened`)
        const stopped = new Promise<void>(resolve => {
          const off = wv.on({
            stopLoading: () => {
              off()
              resolve()
            },
          })
        })
        loadRef.current(url)
        await Promise.race([stopped, settle(10_000)])
        await settle(300)
        return { text: await snapshot() }
      }
      if (!ready.current) throw new Error('the browser is not ready')
      // The webview's own address too: screenshot and console read no page address of their own.
      if (!local(pageRef.current) || !local(wv.url())) throw new Error(`the browser shows a page that is not local; open a page on ${allowed()} with browser_navigate first`)
      if (action === 'snapshot') return { text: await snapshot() }
      if (action === 'console') return { text: logText(pageLog.current) || 'no console warnings, errors or failed requests on this page' }
      if (action === 'screenshot') {
        const image = await wv.capture()
        const path = image ? await window.ide.saveShot(image) : null
        if (!path) throw new Error('the screenshot could not be saved')
        return { path, text: path }
      }
      if (action === 'click') {
        const point = (await run(pointScript(element(args.ref)))) as { x?: number; y?: number; error?: string; by?: string } | undefined
        const refused = refusal(point)
        if (refused) throw new Error(refused)
        const at = { x: point!.x!, y: point!.y! }
        wv.click(at.x, at.y)
        await settle(600)
        return { text: await snapshot() }
      }
      if (action === 'type') {
        const text = String(args.text ?? '')
        const filled = (await run(fillScript(element(args.ref), text))) as { error?: string; done?: boolean } | undefined
        const refused = refusal(filled)
        if (refused) throw new Error(refused)
        // A select, a date, a slider: the script set it; typing would undo that.
        if (!filled?.done) await wv.insertText(text)
        if (args.submit === true) wv.pressEnter()
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
        <IconButton icon="collapse" label={t('browser.back')} onClick={() => ready.current && view.current?.back()} />
        <IconButton icon="expand" label={t('browser.forward')} onClick={() => ready.current && view.current?.forward()} />
        <IconButton icon="reload" label={t('browser.reload')} onClick={() => ready.current && view.current?.reload()} />
        <Input
          compact
          mono
          className="address"
          aria-label={t('browser.address')}
          title={title || undefined}
          value={address}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && !composing(event) && load(address)}
        />
        <Button
          size="sm"
          className={cx('switch', commenting && 'switch-on')}
          role="switch"
          aria-checked={commenting}
          title={t('browser.commentModeTitle')}
          onClick={() => setCommenting(on => !on)}
        >
          <span className="switch-track">
            <span className="switch-knob" />
          </span>
          {t('browser.commentMode')} <kbd>⌥M</kbd>
        </Button>
        <span className="browser-bar-split" />
        <Chip on={drawer === 'comments'} aria-pressed={drawer === 'comments'} onClick={() => setDrawer(d => (d === 'comments' ? null : 'comments'))}>
          {t('browser.drawerComments')}
          {openComments.length > 0 && <Badge shape="count" tone="warn">{openComments.length}</Badge>}
        </Chip>
        <Chip on={drawer === 'servers'} aria-pressed={drawer === 'servers'} onClick={() => setDrawer(d => (d === 'servers' ? null : 'servers'))}>
          {t('dev.servers')}
        </Chip>
      </div>
      <div className="browser-body">
        <div className="webview-wrap">
          {/* A failed load shows its card in the page's place; the Tauri build draws the page above
              the app, so the page is hidden while the card shows, or the card would sit under it. */}
          {on && <PageView src={src} visible={visible && !failure} onSurface={setSurface} />}
          {failure && (
            <div className="load-failure" role="alert">
              <Card pad="none" className="load-failure-box">
                <h2>{t('browser.loadFailed')}</h2>
                <p className="mono load-failure-url">{failure.url}</p>
                <p>{failureReason(failure.code)}</p>
                <p className="quiet small mono">{failure.code}</p>
                <div className="actions">
                  <Button variant="primary" onClick={() => load(failure.url)}>
                    {t('browser.retry')}
                  </Button>
                  {failedTarget ? (
                    <Button disabled={starting} onClick={() => void startFailed(failedTarget)}>
                      {starting ? t('browser.starting') : t('browser.start', { name: failedTarget.name })}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => {
                        debugStore.requestTarget(failure.url)
                        onShow?.()
                      }}
                    >
                      {t('browser.addTarget')}
                    </Button>
                  )}
                </div>
                <p className="quiet small">
                  {failedTarget
                    ? t('browser.targetHint', { name: failedTarget.name })
                    : t('browser.noTargetHint')}
                </p>
              </Card>
            </div>
          )}
        </div>
        {drawer && (
          <aside className="browser-drawer" aria-label={t(drawer === 'comments' ? 'browser.drawerComments' : 'dev.servers')}>
            <div className="drawer-head">
              <h2>{drawer === 'comments' ? t(HEADINGS[filter]) : t('dev.servers')}</h2>
              {drawer === 'comments' && (
                <Select
                  compact
                  mono
                  className="comment-filter"
                  value={filter}
                  title={t('browser.filterTitle')}
                  aria-label={t('browser.filterTitle')}
                  onChange={event => setFilter(event.target.value as CommentFilter)}
                >
                  {(['열림', '보냄', '해결', '전체'] as CommentFilter[]).map(f => (
                    <option key={f} value={f}>
                      {commentStatusLabel(f)} {counts[f]}
                    </option>
                  ))}
                </Select>
              )}
              <IconButton icon="close" size="sm" label={t('common.close')} onClick={() => setDrawer(null)} />
            </div>
            {drawer === 'servers' ? (
              <div className="drawer-body">{servers}</div>
            ) : (
              <>
                <div className="drawer-body comment-panel">
          {shown.length === 0 && (
            <EmptyState className="small">
              {filter !== '열림' ? t(EMPTY[filter]) : commenting ? t('browser.emptyCommenting') : t('browser.emptyOpen')}
            </EmptyState>
          )}
          {shown.map(c => {
            const n = openComments.indexOf(c)
            return (
              <Card key={c.id} sunk pad="sm" className="kept" data-status={commentStatusSlug(c.status)}>
                <div className="kept-head">
                  {n >= 0 ? (
                    <Badge shape="count" tone="warn" className="mark-num">
                      {n + 1}
                    </Badge>
                  ) : (
                    <Badge className="kept-status">{commentStatusLabel(c.status)}</Badge>
                  )}
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
                    <Button variant="link" size="sm" title={t('browser.resolveTitle')} onClick={() => void setStatusOf([c], '해결')}>
                      {t('commentStatus.resolved')}
                    </Button>
                  )}
                  {c.status !== '열림' && (
                    <Button variant="link" size="sm" title={t('browser.reopenTitle')} onClick={() => void setStatusOf([c], '열림')}>
                      {t('browser.reopen')}
                    </Button>
                  )}
                  <Button variant="link" size="sm" title={t('browser.deleteTitle')} onClick={() => void remove(c)}>
                    {t('dev.delete')}
                  </Button>
                </div>
              </Card>
            )
          })}

                </div>
                <div className="drawer-foot">
                  <Button variant="primary" className="wide" disabled={openComments.length === 0 || !targetId} onClick={() => void sendAll()}>
                    {t('browser.sendToClaude')}
                    {openComments.length > 0 ? ` (${openComments.length})` : ''}
                  </Button>
                  {status && <p className="small">{status}</p>}
                  {direct}
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
