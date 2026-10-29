// Makes sure one bridge runs: exits 0 at once when one answers, otherwise starts server.ts
// on its own (detached, its output in ~/.claude-ide/bridge.log) and exits 0 once it
// answers, 1 when it does not within five seconds. The launchers the mod and the app call
// (start-bridge.sh, start-bridge.json: src/main/runtime.ts, scripts/setup.sh) run this with
// the Node they name, which the bridge then runs on too.

import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ideDir, requestTarget, resolveEndpoint } from './endpoint.ts'

export function healthy(): Promise<boolean> {
  const target = requestTarget(resolveEndpoint())
  return new Promise(resolve => {
    const req = request({ ...target, path: '/health', timeout: 1000 }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

if (import.meta.main) {
  if (await healthy()) process.exit(0)
  mkdirSync(ideDir(), { recursive: true, mode: 0o700 })
  const log = openSync(join(ideDir(), 'bridge.log'), 'a')
  const server = join(dirname(fileURLToPath(import.meta.url)), 'server.ts')
  // An AppImage's own executable lives in a folder mounted for one run; the file itself stays.
  spawn(process.env.APPIMAGE ?? process.execPath, [server], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (await healthy()) process.exit(0)
  }
  console.error('bridge did not start; see ~/.claude-ide/bridge.log')
  process.exit(1)
}
