import { request } from 'node:http'
import type { RequestTarget } from '../../bridge/endpoint.ts'

// One SSE subscription to the bridge's /stream. On loss it reports the app as
// disconnected at once, waits, runs beforeRetry (the app restarts the bridge
// there) and subscribes again. Node 24 ends a dropped stream with 'aborted' and
// 'close' rather than 'end' or 'error', so every one of them counts as a loss,
// once per connection.

export type WatchOptions = {
  // Where the bridge is, read at each connection (bridge/endpoint.ts); `socketPath` alone in tests.
  socketPath?: string
  target?: () => RequestTarget
  retryMs: number
  onConnection: (up: boolean) => void
  onEvent: (event: unknown) => void
  beforeRetry?: () => Promise<unknown>
}

// Splits complete SSE frames off the buffer; returns their data payloads and what is left.
export function takeFrames(buffer: string): { data: string[]; rest: string } {
  const data: string[] = []
  let rest = buffer
  let end = rest.indexOf('\n\n')
  while (end !== -1) {
    const frame = rest.slice(0, end)
    rest = rest.slice(end + 2)
    end = rest.indexOf('\n\n')
    const line = frame.split('\n').find(l => l.startsWith('data: '))
    if (line) data.push(line.slice(6))
  }
  return { data, rest }
}

export function watchBridge(options: WatchOptions): { stop: () => void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let current: { destroy: () => void } | null = null

  const connect = (): void => {
    if (stopped) return
    let lost = false
    const loss = (): void => {
      if (lost) return
      lost = true
      req.destroy()
      options.onConnection(false)
      if (stopped) return
      timer = setTimeout(() => {
        timer = null
        void (options.beforeRetry?.() ?? Promise.resolve()).catch(() => undefined).then(connect)
      }, options.retryMs)
    }
    const where = options.target?.() ?? { socketPath: options.socketPath, headers: {} }
    const req = request({ ...where, path: '/stream' }, res => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume()
        loss()
        return
      }
      options.onConnection(true)
      options.onEvent({ type: 'connected' })
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const next = takeFrames(buffer + chunk)
        buffer = next.rest
        for (const data of next.data) {
          try {
            options.onEvent(JSON.parse(data))
          } catch {
            // a broken frame is skipped; the next change refetches everything anyway
          }
        }
      })
      res.on('end', loss)
      res.on('aborted', loss)
      res.on('close', loss)
      res.on('error', loss)
    })
    req.on('error', loss)
    req.on('close', loss)
    req.end()
    current = req
  }

  connect()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      current?.destroy()
    },
  }
}
