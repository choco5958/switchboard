import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { takeFrames, watchBridge } from './bridgeWatch'

const SERVER = join(import.meta.dirname, '../../bridge/server.ts')

// A real bridge process on a short throwaway socket, as the app would see it.
function startBridge(socketPath: string, db: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, CLAUDE_IDE_SOCKET: socketPath, CLAUDE_IDE_DB: db },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('listening')) resolve(child)
      if (out.includes('not started')) reject(new Error(out))
    })
    child.on('error', reject)
  })
}

function post(socketPath: string, path: string, body: unknown): Promise<number> {
  return new Promise(resolve => {
    const req = request({ socketPath, method: 'POST', path, headers: { 'content-type': 'application/json' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(0))
    req.end(JSON.stringify(body))
  })
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('takeFrames', () => {
  it('splits whole frames and keeps the partial one', () => {
    expect(takeFrames('data: {"a":1}\n\n: ping\n\ndata: {"b"')).toEqual({ data: ['{"a":1}'], rest: 'data: {"b"' })
  })
})

describe('watchBridge against a real bridge', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn()
  })

  it('marks the app disconnected when the bridge dies and reconnects when it is back', async () => {
    const dir = mkdtempSync('/tmp/cide-w')
    const socketPath = join(dir, 'b.sock')
    const db = join(dir, 'ide.db')
    let bridge = await startBridge(socketPath, db)
    cleanup.push(() => {
      bridge.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    })

    const states: boolean[] = []
    const events: { type?: string }[] = []
    let restarts = 0
    const watcher = watchBridge({
      socketPath,
      retryMs: 50,
      onConnection: up => states.push(up),
      onEvent: event => events.push(event as { type?: string }),
      // What the app does here: start the bridge again before resubscribing.
      beforeRetry: async () => {
        restarts++
        if (restarts === 1) bridge = await startBridge(socketPath, db)
      },
    })
    cleanup.push(() => watcher.stop())

    await until(() => states.at(-1) === true)
    expect(await post(socketPath, '/settings', { key: 'theme', value: 'metro' })).toBe(200)
    await until(() => events.some(e => e.type !== 'connected'))

    bridge.kill('SIGKILL')
    await until(() => states.at(-1) === false)
    // Lost once, not once per close/aborted event.
    expect(states).toEqual([true, false])

    await until(() => states.at(-1) === true)
    expect(states).toEqual([true, false, true])
    // The renderer refetches /state on this event after every reconnect.
    expect(events.filter(e => e.type === 'connected')).toHaveLength(2)
  }, 20000)
})
