// BROWSER for the app's terminals: a dev server link a CLI opens (vite, a test runner) goes to
// the in-app browser through the bridge's /dev/open; anything else (a sign-in page, docs)
// opens in the person's own browser as before. A .js file, because tools such as Vite run a
// BROWSER that ends in .js with node and hand any other value to `open -a` as an app name.

import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Also the script's own copy: openUrlScript embeds its source, which the build has stripped of types.
export function isLocalAddress(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const parts = host.split('.').map(Number)
  return parts.length === 4 && parts[0] === 127 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
}

export function openUrlScript(): string {
  return `#!/usr/bin/env node
// Written by Switchboard each time it starts: BROWSER for its terminals (src/main/openUrl.ts).
const { request } = require('node:http')
const { spawn } = require('node:child_process')
const { homedir } = require('node:os')
const { join } = require('node:path')
const url = process.argv[2] || ''
const isLocalAddress = (${isLocalAddress.toString()})
const own = () => {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  process.exit(0)
}
if (!isLocalAddress(url)) own()
else {
  const socketPath = process.env.CLAUDE_IDE_SOCKET || join(homedir(), '.claude-ide', 'bridge.sock')
  const req = request({ socketPath, method: 'POST', path: '/dev/open', headers: { 'content-type': 'application/json' } }, res => {
    res.resume()
    res.on('end', () => (res.statusCode === 200 ? process.exit(0) : own()))
  })
  req.on('error', own)
  req.end(JSON.stringify({ url }))
}
`
}

export function writeOpenUrl(dir: string): string {
  const path = join(dir, 'open-url.js')
  writeFileSync(path, openUrlScript())
  chmodSync(path, 0o755)
  return path
}
