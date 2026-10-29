import { EventEmitter } from 'node:events'
import type { IpcMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { bridgePathAllowed, debugPathAllowed, guardIpc, hardenWebview, isAppUrl, isExternalUrl } from './guard'

const FILE_APP = 'file:///Applications/Claude%20IDE.app/Contents/Resources/app/out/renderer/index.html'

describe('isAppUrl', () => {
  it('accepts the bundled page with any hash or query', () => {
    expect(isAppUrl(FILE_APP, FILE_APP)).toBe(true)
    expect(isAppUrl(`${FILE_APP}#/tasks?x=1`, FILE_APP)).toBe(true)
  })
  it('rejects other files and web pages', () => {
    expect(isAppUrl('file:///tmp/evil.html', FILE_APP)).toBe(false)
    expect(isAppUrl('https://example.com/', FILE_APP)).toBe(false)
    expect(isAppUrl('', FILE_APP)).toBe(false)
    expect(isAppUrl(null, FILE_APP)).toBe(false)
  })
  it('accepts only the dev server origin in development', () => {
    expect(isAppUrl('http://localhost:5173/src/main.tsx', 'http://localhost:5173/')).toBe(true)
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173/')).toBe(false)
    expect(isAppUrl('http://evil.test/', 'http://localhost:5173/')).toBe(false)
  })
})

describe('isExternalUrl', () => {
  it('opens only web links outside the app', () => {
    expect(isExternalUrl('https://claude.ai/')).toBe(true)
    expect(isExternalUrl('http://localhost:3000/')).toBe(true)
    expect(isExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalUrl('not a url')).toBe(false)
  })
})

describe('bridgePathAllowed', () => {
  it('lets the screens reach their own routes', () => {
    expect(bridgePathAllowed('/settings')).toBe(true)
    expect(bridgePathAllowed('/tasks/3/restore')).toBe(true)
    expect(bridgePathAllowed('/tasks/archive-done')).toBe(true)
    expect(bridgePathAllowed('/commands/12')).toBe(true)
  })
  it('rejects routes outside the list', () => {
    expect(bridgePathAllowed('/outbox')).toBe(false)
    expect(bridgePathAllowed('/tasksx')).toBe(false)
    expect(bridgePathAllowed('tasks')).toBe(false)
    expect(bridgePathAllowed(42)).toBe(false)
  })
  it('rejects climbing out of an allowed route', () => {
    expect(bridgePathAllowed('/tasks/../outbox')).toBe(false)
    expect(bridgePathAllowed('/tasks/%2e%2e/outbox')).toBe(false)
    expect(bridgePathAllowed('/tasks/%2E./outbox')).toBe(false)
    expect(bridgePathAllowed('/tasks/..%2Foutbox')).toBe(false)
    expect(bridgePathAllowed('/tasks/%2fx')).toBe(false)
    expect(bridgePathAllowed('/tasks\\..\\outbox')).toBe(false)
    expect(bridgePathAllowed('/tasks//outbox')).toBe(false)
  })
})

describe('hardenWebview', () => {
  it('strips the preload and Node from a webview', () => {
    const prefs = { preload: '/x/preload.js', nodeIntegration: true, contextIsolation: false, partition: 'persist:claude-ide' }
    const params: Record<string, string> = { src: 'http://localhost:5173', partition: 'persist:other', preload: 'file:///x.js' }
    hardenWebview(prefs, params)
    expect(prefs).toEqual({
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, partition: 'persist:claude-ide',
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    })
    // The page cannot pick another session or a preload of its own.
    expect(params).toEqual({ src: 'http://localhost:5173', partition: 'persist:claude-ide' })
  })
})

describe('guardIpc', () => {
  // Enough of ipcMain for the proxy: handle keeps the handler, on is an emitter.
  function fakeIpc() {
    const emitter = new EventEmitter()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipc = Object.assign(emitter, {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, fn),
      handleOnce: () => undefined,
    })
    return { ipc: ipc as unknown as IpcMain, handlers, emitter }
  }
  const from = (url: string | null) => ({ senderFrame: url === null ? null : { url } })
  const trusted = (event: { senderFrame?: { url: string } | null }) => isAppUrl(event.senderFrame?.url, FILE_APP)

  it('runs handlers for the app page and rejects other senders', async () => {
    const { ipc, handlers } = fakeIpc()
    guardIpc(ipc, trusted as never).handle('x', (_e, a) => `got ${String(a)}`)
    const handler = handlers.get('x')!
    expect(await handler(from(FILE_APP), 1)).toBe('got 1')
    expect(() => handler(from('https://evil.test/'), 1)).toThrow(/blocked x/)
    expect(() => handler(from(null), 1)).toThrow(/blocked x/)
  })

  it('drops plain messages from other senders and can remove the listener', () => {
    const { ipc, emitter } = fakeIpc()
    const guarded = guardIpc(ipc, trusted as never)
    const got: unknown[] = []
    const listener = (_e: unknown, data: unknown) => void got.push(data)
    guarded.on('w', listener)
    emitter.emit('w', from(FILE_APP), 'ok')
    emitter.emit('w', from('file:///tmp/evil.html'), 'bad')
    expect(got).toEqual(['ok'])
    guarded.off('w', listener)
    expect(emitter.listenerCount('w')).toBe(0)
  })
})

describe('debug calls', () => {
  it('reach only the debugging routes and never climb out', () => {
    expect(debugPathAllowed('/comments?url=http%3A%2F%2Fx')).toBe(true)
    expect(debugPathAllowed('/dev/open')).toBe(true)
    expect(debugPathAllowed('/sessions/live')).toBe(true)
    expect(debugPathAllowed('/comments/../outbox')).toBe(false)
    expect(debugPathAllowed('/outbox')).toBe(false)
  })
})
