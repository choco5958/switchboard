import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isLocalAddress, writeOpenUrl } from './openUrl'

test('only this computer counts as local for links a terminal opens', () => {
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8951/x', 'https://app.localhost', 'http://[::1]:3000']) expect(isLocalAddress(url), url).toBe(true)
  for (const url of ['https://github.com/login', 'http://192.168.0.7:3000', 'file:///x', 'nope']) expect(isLocalAddress(url), url).toBe(false)
})

test('the script sends a local link to the bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-open-'))
  const script = writeOpenUrl(dir)
  expect(statSync(script).mode & 0o777).toBe(0o755)
  const socket = join(dir, 'b.sock')
  const got: string[] = []
  // A stand-in bridge: it records the request and answers 200.
  const server = createServer(conn => {
    conn.on('data', chunk => {
      got.push(chunk.toString())
      conn.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}')
    })
  })
  await new Promise<void>(resolve => server.listen(socket, resolve))
  await new Promise<void>((resolve, reject) =>
    execFile(process.execPath.includes('electron') ? 'node' : process.execPath, [script, 'http://localhost:5173/'], { env: { ...process.env, CLAUDE_IDE_SOCKET: socket } }, error => (error ? reject(error) : resolve())),
  )
  server.close()
  rmSync(dir, { recursive: true, force: true })
  expect(got.join('')).toMatch(/^POST \/dev\/open/)
  expect(got.join('')).toContain('{"url":"http://localhost:5173/"}')
})
