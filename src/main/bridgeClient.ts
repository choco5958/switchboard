// The app's requests to the bridge. The app's key goes only to a bridge that proved it holds
// the key first (bridge/endpoint.ts bridgeProof), over the same connection the proof came on:
// a program that listens where the bridge was (its socket after it stopped, its old port on
// Windows) gets the requests without the key and cannot answer for the person. Nothing here
// imports Electron, so the tests run all of it.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Agent, request, type ClientRequestArgs } from 'node:http'
import type { Duplex } from 'node:stream'
import { statSync } from 'node:fs'
import { APP_HEADER, PROVE_PATH, bridgeProof, type RequestTarget } from '../../bridge/endpoint.ts'
import type { Reply } from '../shared/types'

// `proven`: the answer came from a bridge that proved the app's key.
export type BridgeReply = Reply & { proven?: boolean }

// One connection and no other: the request after the proof must not reach anyone else.
class OneConnection extends Agent {
  private made = 0
  constructor() {
    super({ keepAlive: true, maxSockets: 1 })
  }
  override createConnection(options: ClientRequestArgs, done?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    if (this.made++ > 0) {
      done?.(new Error('the bridge connection closed'), undefined as unknown as Duplex)
      return undefined
    }
    return super.createConnection(options, done)
  }
}

// Where the bridge listens as the app finds it, in the bridge's own words (bridgeProof's `bound`).
function boundOf(target: RequestTarget): string | null {
  if (target.socketPath) {
    try {
      return `inode:${statSync(target.socketPath).ino}`
    } catch {
      return null
    }
  }
  return target.port ? `port:${target.port}` : null
}

function send(target: RequestTarget, method: string, path: string, headers: Record<string, string>, body: unknown, agent?: Agent): Promise<Reply> {
  return new Promise(resolve => {
    const req = request({ ...target, ...(agent ? { agent } : {}), method, path, headers: { ...target.headers, ...headers } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (text += chunk))
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
        } catch {
          json = { error: text }
        }
        const status = res.statusCode ?? 0
        resolve({ ok: status >= 200 && status < 300, status, json })
      })
    })
    req.on('error', error => resolve({ ok: false, status: 0, json: { error: error.message } }))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const sameHex = (given: unknown, expected: string) => {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

// Asks the bridge on `agent`'s connection to prove the key; the pid it proved it for, or null.
async function prove(target: RequestTarget, key: string, agent: Agent): Promise<number | null> {
  const bound = boundOf(target)
  if (!key || !bound) return null
  const nonce = randomBytes(32).toString('hex')
  const reply = await send(target, 'GET', `${PROVE_PATH}?nonce=${nonce}`, {}, undefined, agent)
  const pid = reply.json.pid
  if (!reply.ok || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  return sameHex(reply.json.proof, bridgeProof(key, nonce, pid, bound)) ? pid : null
}

export function bridgeClient(target: () => RequestTarget, key: () => string) {
  return {
    // /health tells only what any program may know; everything else carries the key when the
    // bridge proves it holds the key, and goes without it otherwise.
    async call(method: string, path: string, body?: unknown): Promise<BridgeReply> {
      const where = target()
      const headers = { 'content-type': 'application/json' }
      if (path === '/health') return send(where, method, path, headers, body)
      const agent = new OneConnection()
      try {
        if ((await prove(where, key(), agent)) === null) return send(where, method, path, headers, body)
        return { ...(await send(where, method, path, { ...headers, [APP_HEADER]: key() }, body, agent)), proven: true }
      } finally {
        agent.destroy()
      }
    },

    // The pid of the bridge serving now, when it proves the key: the one the app may stop.
    async provenPid(): Promise<number | null> {
      const agent = new OneConnection()
      try {
        return await prove(target(), key(), agent)
      } finally {
        agent.destroy()
      }
    },
  }
}
