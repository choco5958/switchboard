// The permission relay with a real agent CLI, end to end, the same on macOS, Windows and Linux:
// Copilot CLI (BYOK: a model server of this script's own, so no GitHub sign-in) opened the way
// the app opens it (src/shared/agents.ts presetLaunch, with the relay hook), a throwaway bridge,
// the app's answer, and the file the agent writes once it is allowed.
//
//   pnpm exec jiti scripts/relay-check.ts [copilot executable or its npm-loader.js]
//
// Needs `node scripts/build-node.ts` first (out/node/mcp). Everything lives in a temporary folder:
// HOME, USERPROFILE, COPILOT_HOME, the bridge's socket and database. Only the processes this script
// started are stopped.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { requestTarget, resolveEndpoint } from '../bridge/endpoint.ts'
import { presetLaunch, presetOf } from '../src/shared/agents'
import { serverFor } from '../src/main/agentDetect'
import { copilotTrustText } from '../src/main/agentTrust'
import { testHome, until, type Env } from './tauri-smoke.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WINDOWS = process.platform === 'win32'

// The bridge as the app calls it, with the app's key.
function app(env: Env, home: string, key: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const target = requestTarget(resolveEndpoint(env, home))
  return new Promise((done, fail) => {
    const sent = request({ ...target, method, path, headers: { ...target.headers, 'content-type': 'application/json', 'x-switchboard-app': key }, timeout: 5000 }, reply => {
      let text = ''
      reply.on('data', chunk => (text += chunk))
      reply.on('end', () => {
        try {
          done({ status: reply.statusCode ?? 0, json: JSON.parse(text || '{}') as Record<string, unknown> })
        } catch {
          done({ status: reply.statusCode ?? 0, json: {} })
        }
      })
    })
    sent.on('error', fail)
    sent.on('timeout', () => sent.destroy(new Error('timed out')))
    sent.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// An OpenAI-compatible model: the first answer of a conversation creates hello.txt with Copilot's
// create tool, every later one (a tool result is in the messages) says done.
function fakeModel(file: string): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      let json: { messages?: { role?: string }[]; stream?: boolean } = {}
      try {
        json = JSON.parse(body || '{}') as typeof json
      } catch {
        // an empty request
      }
      res.setHeader('content-type', req.url?.includes('chat/completions') && json.stream ? 'text/event-stream' : 'application/json')
      if (!req.url?.includes('chat/completions')) return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }))
      const done = (json.messages ?? []).some(m => m.role === 'tool')
      const call = { id: 'call_1', type: 'function', function: { name: 'create', arguments: JSON.stringify({ path: file, file_text: 'hi' }) } }
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      if (!json.stream) {
        const message = done ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [call] }
        return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }], usage }))
      }
      const delta = done ? { role: 'assistant', content: 'done' } : { role: 'assistant', tool_calls: [{ index: 0, ...call }] }
      const chunk = (choice: unknown) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [choice], usage })}\n\n`
      res.write(chunk({ index: 0, delta, finish_reason: null }))
      res.write(chunk({ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }))
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      done({ url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`, close: () => server.close() })
    }),
  )
}

// How to start Copilot: its native executable, or the npm package's loader run with node.
function copilotCommand(given: string | undefined): string[] {
  if (given) return given.endsWith('.js') ? [process.execPath, given] : [given]
  const root = spawnSync(WINDOWS ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: WINDOWS }).stdout.trim()
  const pkg = join(root, '@github', 'copilot')
  const bin = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }).bin
  const entry = typeof bin === 'string' ? bin : (bin?.copilot ?? 'npm-loader.js')
  return [process.execPath, join(pkg, entry)]
}

async function main(): Promise<number> {
  const copilot = copilotCommand(process.argv[2])
  const version = spawnSync(copilot[0]!, [...copilot.slice(1), '--version'], { encoding: 'utf8' }).stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null
  console.log(`copilot ${version ?? 'unknown'}: ${copilot.join(' ')}`)
  const { work, home, env } = testHome('sb-relay-')
  const project = realpathSync(work) + (WINDOWS ? '\\proj' : '/proj')
  mkdirSync(project, { recursive: true })
  const file = join(project, 'hello.txt')
  const copilotHome = join(work, 'copilot')
  mkdirSync(copilotHome, { recursive: true })
  writeFileSync(join(copilotHome, 'config.json'), copilotTrustText(null, project)!)
  const appKey = randomBytes(32).toString('hex')
  const started: ChildProcess[] = []
  const model = await fakeModel(file)
  let failed = ''
  try {
    const bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'server.ts')], { cwd: ROOT, env: { ...env, SWITCHBOARD_APP_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'inherit'] })
    started.push(bridge)
    bridge.stdin!.end(`${appKey}\n`)
    await until('the bridge', async () => (await app(env, home, appKey, 'GET', '/health')).status === 200, 20000)
    await app(env, home, appKey, 'POST', '/presence', { away: true })

    // The run as the app opens it (src/main/agentTerms.ts), without the shell line: the args each
    // part adds, in its order.
    const terminal = randomBytes(16).toString('hex')
    const server = serverFor(process.execPath, join(ROOT, 'out', 'node', 'mcp', 'server.mjs'), 'copilot', terminal, env.CLAUDE_IDE_SOCKET)
    const hook = { command: process.execPath, args: [join(ROOT, 'out', 'node', 'mcp', 'hook.mjs'), 'copilot'] }
    const configFile = join(home, '.claude-ide', 'agents', `${terminal}-copilot.json`)
    const preset = presetOf('copilot')!
    const launch = presetLaunch(preset, server, configFile, process.platform, hook, version)
    for (const f of launch.files) {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content)
    }
    const injected = preset.mcp!(server, configFile)
    const hooked = preset.permissionHook!(hook, { hookFile: configFile.replace(/\.json$/, '-hook.json'), injected, version })
    const args = [...(injected.args ?? []), ...(hooked.args ?? [])]
    if (!args.includes('--plugin-dir')) throw new Error(`no relay hook for Copilot ${version}`)

    const cli = spawn(copilot[0]!, [...copilot.slice(1), ...args, '-p', 'make hello.txt'], {
      cwd: project,
      env: {
        ...env,
        ...launch.env,
        SWITCHBOARD_TERMINAL: terminal,
        COPILOT_HOME: copilotHome,
        COPILOT_OFFLINE: 'true',
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_PROVIDER_BASE_URL: model.url,
        COPILOT_MODEL: 'gpt-4.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    started.push(cli)
    let output = ''
    cli.stdout!.on('data', chunk => (output += chunk))
    cli.stderr!.on('data', chunk => (output += chunk))
    const ended = new Promise<number | null>(done => cli.once('exit', done))

    const ask = await until(
      'the ask in the bridge queue',
      async () => {
        const state = await app(env, home, appKey, 'GET', '/state')
        return ((state.json.approvals ?? []) as { id: number; status: string; tool: string; summary: string }[]).find(a => a.status === 'pending')
      },
      120000,
    ).catch(error => {
      throw new Error(`${error instanceof Error ? error.message : error}\n${output.slice(-1500)}`)
    })
    console.log(`ask ${ask.id}: ${ask.tool}, ${ask.summary.split('\n')[0]}`)
    if (!ask.summary.includes('hello.txt')) throw new Error(`the summary does not name the file: ${ask.summary}`)
    const answered = await app(env, home, appKey, 'POST', `/approvals/${ask.id}/answer`, { decision: 'allow', note: '' })
    if (answered.status !== 200) throw new Error(`answer: ${answered.status} ${JSON.stringify(answered.json)}`)
    const code = await Promise.race([ended, new Promise<string>(done => setTimeout(() => done('timed out'), 120000))])
    if (!existsSync(file)) throw new Error(`no hello.txt after allowing (copilot: ${code})\n${output.slice(-1500)}`)
    console.log(`allowed, and Copilot wrote hello.txt (exit ${code})`)
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error)
  } finally {
    for (const child of started.reverse()) if (child.exitCode === null) child.kill()
    model.close()
    // Windows keeps a file a stopped process held for a moment.
    await new Promise(r => setTimeout(r, 1500))
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  }
  if (failed) console.log(`FAILED: ${failed}`)
  return failed ? 1 : 0
}

process.exit(await main())
