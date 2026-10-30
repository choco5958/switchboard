import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createBridge, listen, listenTcp, newToken } from '../../bridge/server.ts'
import { requestTarget, resolveEndpoint } from '../../bridge/endpoint.ts'
import { bridgeClient } from './bridgeClient'

const unix = process.platform !== 'win32'
const KEY = 'b'.repeat(64)
// Short: a socket path has a length limit (104 bytes on macOS).
const dir = mkdtempSync(join(unix ? '/tmp' : tmpdir(), 'sbbc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A stand-in that keeps every byte it gets; `relay` passes them on to the real bridge.
function listener(at: string | number, relay?: { socketPath?: string; port?: number }): Promise<{ server: Server; got: () => string; port: number }> {
  let got = ''
  const server = createServer(socket => {
    socket.on('data', chunk => (got += chunk.toString()))
    socket.on('error', () => undefined)
    if (relay) {
      const out = relay.socketPath ? connect(relay.socketPath) : connect(relay.port!, '127.0.0.1')
      out.on('error', () => socket.destroy())
      socket.pipe(out).pipe(socket)
    } else socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}'))
  })
  return new Promise(resolve =>
    typeof at === 'string'
      ? server.listen(at, () => resolve({ server, got: () => got, port: 0 }))
      : server.listen(at, '127.0.0.1', () => resolve({ server, got: () => got, port: (server.address() as { port: number }).port })),
  )
}

describe.skipIf(!unix)('the app key goes only to a bridge that proves it holds it (socket)', () => {
  it('the real bridge proves it, and gets the key', async () => {
    const sock = join(dir, 'b.sock')
    const bridge = createBridge(join(dir, 'a.db'), 'en-US', { appKey: KEY, tailscale: null })
    await listen(bridge.server, sock)
    try {
      const target = () => requestTarget({ kind: 'socket', path: sock })
      const own = bridgeClient(target, () => KEY)
      expect(await own.call('GET', '/app/check')).toMatchObject({ ok: true, proven: true })
      expect(await own.provenPid()).toBe(process.pid)
      // Another key: the bridge cannot prove it, and the request goes without one.
      const other = bridgeClient(target, () => 'c'.repeat(64))
      expect(await other.call('GET', '/app/check')).toMatchObject({ ok: false, status: 403 })
      expect(await other.provenPid()).toBe(null)

      // Something in the bridge's place, or passing its words on from another socket, gets no key.
      const fake = await listener(join(dir, 'fake.sock'))
      const relay = await listener(join(dir, 'relay.sock'), { socketPath: sock })
      for (const one of [fake, relay]) {
        const path = String(one.server.address())
        const reply = await bridgeClient(() => requestTarget({ kind: 'socket', path }), () => KEY).call('POST', '/presence', { away: true })
        expect(reply.proven).toBeUndefined()
        expect(one.got()).toContain('/presence')
        expect(one.got()).not.toContain(KEY)
        one.server.close()
      }
      expect(await bridgeClient(() => requestTarget({ kind: 'socket', path: join(dir, 'none.sock') }), () => KEY).call('GET', '/state')).toMatchObject({ ok: false, status: 0 })

      // The delivery stream's target: the key only for the bridge that proved it.
      const stream = await own.streamTarget()
      expect(stream.where.headers).toMatchObject({ 'x-switchboard-app': KEY })
      expect(stream.where.agent).toBeDefined()
      stream.done()
      const fake2 = await listener(join(dir, 'fake2.sock'))
      const unproven = await bridgeClient(() => requestTarget({ kind: 'socket', path: join(dir, 'fake2.sock') }), () => KEY).streamTarget()
      expect(JSON.stringify(unproven.where)).not.toContain(KEY)
      expect(fake2.got()).not.toContain(KEY)
      fake2.server.close()
    } finally {
      bridge.close()
    }
  })
})

describe('the app key goes only to a bridge that proves it holds it (TCP)', () => {
  it('a bridge on the port proves it; a program on another port passing its answers on does not', async () => {
    const home = mkdtempSync(join(dir, 'h-'))
    const token = newToken()
    const bridge = createBridge(join(home, 'a.db'), 'en-US', { appKey: KEY, token, tailscale: null })
    try {
      await listenTcp(bridge.server, token, home)
      const endpoint = resolveEndpoint({ CLAUDE_IDE_TCP: '1' }, home)
      expect(await bridgeClient(() => requestTarget(endpoint), () => KEY).call('GET', '/app/check')).toMatchObject({ ok: true, proven: true })
      // The /health the app reads to find the bridge carries no key.
      const relay = await listener(0, { port: endpoint.kind === 'tcp' ? endpoint.port : 0 })
      const moved = requestTarget({ kind: 'tcp', port: relay.port, token: endpoint.kind === 'tcp' ? endpoint.token : '' })
      const client = bridgeClient(() => moved, () => KEY)
      expect((await client.call('GET', '/health')).ok).toBe(true)
      expect(await client.call('GET', '/app/check')).toMatchObject({ ok: false, status: 403 })
      expect(relay.got()).not.toContain(KEY)
      relay.server.close()
    } finally {
      bridge.close()
    }
  })
})
