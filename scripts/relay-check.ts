// The hooks of a real agent CLI, end to end, the same on macOS, Windows and Linux: the CLI opened the
// way the app opens it (src/shared/agents.ts presetRun, with the relay hook), a model server of this
// script's own (so no sign-in), a throwaway bridge and the app's answer. It checks that
//   - the hooks follow the turn: the bridge sees the session working while the model has not
//     answered yet (the turn's start), and idle once the CLI is done (the turn's end);
//   - a permission ask while the person is away reaches the bridge, and the app's "allow" lets the
//     CLI write the file (not for Gemini, whose hooks cannot allow a tool).
//
//   npx -y jiti@2.6.1 scripts/relay-check.ts <copilot|qwen|crush|opencode|codex|gemini> [command...]
//
// The command defaults to the CLI's npm package installed globally (run with node), or else the
// CLI's name on PATH. Needs `node scripts/build-node.ts` first (out/node). Everything lives in a
// temporary folder: HOME, USERPROFILE, the CLI's config, the bridge's socket and database, and a
// copy of out/node in a folder whose name holds a space, as a Windows home often does. Only the
// processes this script started are stopped.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { requestTarget, resolveEndpoint } from '../bridge/endpoint.ts'
import { codexHookCommand, codexHookOverrides, geminiExtension, geminiRun, hookAttaches, presetOf, presetRun, type McpServer } from '../src/shared/agents'
import { npmShimScript, serverFor } from '../src/main/agentDetect'
import { copilotTrustText } from '../src/main/agentTrust'
import { trustCodexHook } from '../src/main/codexHook'
import { linkGeminiExtension } from '../src/main/geminiExtension'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import { testHome, until, type Env } from './tauri-smoke.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WINDOWS = process.platform === 'win32'
const PROMPT = 'make hello.txt'

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

// One model for every CLI: OpenAI chat completions, OpenAI responses or the Gemini API, by the path
// asked. A conversation's first answer calls `tool` (or says done when there is none); every answer
// after a tool result says done. Answers wait for `open()`: the turn has started by then, so the
// bridge sees the session working before the model has said anything.
type Tool = { name: string; args: Record<string, unknown> }
function fakeModel(tool: Tool | null): Promise<{ url: string; open: () => void; asked: () => number; close: () => void }> {
  let opened: () => void = () => {}
  const gate = new Promise<void>(done => (opened = done))
  let asked = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      let json: Record<string, unknown> = {}
      try {
        json = JSON.parse(body || '{}') as Record<string, unknown>
      } catch {
        // an empty request
      }
      const url = req.url ?? ''
      const send = (type: string, value: unknown) => {
        res.setHeader('content-type', type)
        res.end(typeof value === 'string' ? value : JSON.stringify(value))
      }
      if (url.includes(':countTokens')) return send('application/json', { totalTokens: 1 })
      if (!/chat\/completions|\/responses|:generateContent|:streamGenerateContent/.test(url)) return send('application/json', { data: [{ id: 'fake', object: 'model' }] })
      asked++
      await gate
      const text = (value: unknown) => JSON.stringify(value)
      if (url.includes('chat/completions')) {
        const messages = (json.messages ?? []) as { role?: string; content?: unknown }[]
        if (process.env.RELAY_DEBUG) console.log('model:', JSON.stringify(messages.at(-1)).slice(0, 600), 'tools:', ((json.tools ?? []) as { function?: { name?: string } }[]).map(t => t.function?.name).join(','))
        // A request without the tool (OpenCode's title for the session) gets text.
        const offered = ((json.tools ?? []) as { function?: { name?: string } }[]).some(t => t.function?.name === tool?.name)
        const done = !tool || !offered || messages.some(m => m.role === 'tool')
        const call = tool && { id: 'call_1', type: 'function', function: { name: tool.name, arguments: text(tool.args) } }
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        if (!json.stream) {
          const message = done ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [call] }
          return send('application/json', { id: 'c1', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }], usage })
        }
        const delta = done ? { role: 'assistant', content: 'done' } : { role: 'assistant', tool_calls: [{ index: 0, ...call }] }
        const chunk = (choice: unknown) => `data: ${text({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [choice], usage })}\n\n`
        return send('text/event-stream', chunk({ index: 0, delta, finish_reason: null }) + chunk({ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }) + 'data: [DONE]\n\n')
      }
      if (url.includes('/responses')) {
        const input = (Array.isArray(json.input) ? json.input : []) as { type?: string }[]
        const done = !tool || input.some(i => i.type === 'function_call_output' || i.type === 'custom_tool_call_output')
        const item = done
          ? { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
          : { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: tool!.name, arguments: text(tool!.args) }
        const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
        const event = (type: string, data: object) => `event: ${type}\ndata: ${text({ type, ...data })}\n\n`
        return send(
          'text/event-stream',
          event('response.created', { response: { id: 'resp_1' } }) +
            event('response.output_item.added', { output_index: 0, item }) +
            (done ? event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'done' }) : '') +
            event('response.output_item.done', { output_index: 0, item }) +
            event('response.completed', { response: { id: 'resp_1', usage } }),
        )
      }
      // Gemini: a JSON-mode ask (whose turn is next) hands the turn back to the person.
      const contents = (Array.isArray(json.contents) ? json.contents : []) as { parts?: { functionResponse?: unknown }[] }[]
      const config = (json.generationConfig ?? json.config ?? {}) as { responseMimeType?: string }
      const done = !tool || contents.at(-1)?.parts?.some(p => p.functionResponse)
      const part =
        config.responseMimeType === 'application/json'
          ? { text: text({ next_speaker: 'user', reasoning: 'done' }) }
          : done
            ? { text: 'done' }
            : { functionCall: { name: tool!.name, args: tool!.args } }
      const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: 'fake' }
      return url.includes('stream') ? send('text/event-stream', `data: ${text(chunk)}\n\n`) : send('application/json', chunk)
    })
  })
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      done({ url: `http://127.0.0.1:${port}`, open: () => opened(), asked: () => asked, close: () => server.close() })
    }),
  )
}

// What a check needs to know of its folders and model.
type At = { work: string; home: string; project: string; file: string; model: string; terminal: string; node: string; hook: McpServer; env: Env }
// One CLI: its npm package, the tool call its model makes (null: none, for Gemini), and how it
// starts (`run`: its own config and the args after the app's). `tty`: in a terminal, as the app
// opens it, with the prompt typed in, for a CLI whose run without one leaves out what is checked
// (Qwen's -p turns down a write it would ask about, Codex's exec never asks, OpenCode's run does
// not load the plugin's turn events). It runs until the turn's end; the others run to their exit.
type Spec = {
  npm: string
  bin: string
  tty?: boolean
  tool: ((file: string) => Tool) | null
  run: (at: At, cli: string[]) => Promise<{ args: string[]; env: Record<string, string> }>
}

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const SPECS: Record<string, Spec> = {
  // Copilot (BYOK): the model server stands in for the provider.
  copilot: {
    npm: '@github/copilot',
    bin: 'copilot',
    tool: file => ({ name: 'create', args: { path: file, file_text: 'hi' } }),
    run: async at => {
      const copilotHome = join(at.work, 'copilot')
      write(join(copilotHome, 'config.json'), copilotTrustText(null, at.project)!)
      return {
        args: ['-p', PROMPT],
        env: { COPILOT_HOME: copilotHome, COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_PROVIDER_BASE_URL: `${at.model}/v1`, COPILOT_MODEL: 'gpt-4.1' },
      }
    },
  },
  // Qwen asks before a write in its default approval mode.
  qwen: {
    npm: '@qwen-code/qwen-code',
    bin: 'qwen',
    tty: true,
    tool: file => ({ name: 'write_file', args: { file_path: file, content: 'hi' } }),
    run: async at => {
      write(join(at.home, '.qwen', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'fake' } }))
      return { args: ['--approval-mode', 'default'], env: { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `${at.model}/v1`, OPENAI_MODEL: 'fake' } }
    },
  },
  // Crush's run: its PreToolUse hook asks whatever Crush itself would allow.
  crush: {
    npm: '@charmland/crush',
    bin: 'crush',
    tool: file => ({ name: 'write', args: { file_path: file, content: 'hi' } }),
    run: async at => {
      const config = join(at.work, 'crush-config')
      const fake = { name: 'fake', type: 'openai-compat', base_url: `${at.model}/v1`, api_key: 'test', models: [{ id: 'fake', name: 'fake', context_window: 100000, default_max_tokens: 1000 }] }
      write(
        join(config, 'crush.json'),
        JSON.stringify({ providers: { fake }, models: { large: { model: 'fake', provider: 'fake' }, small: { model: 'fake', provider: 'fake' } }, options: { disable_provider_auto_update: true } }),
      )
      return { args: ['run', PROMPT], env: { CRUSH_GLOBAL_CONFIG: config, CRUSH_GLOBAL_DATA: join(at.work, 'crush-data') } }
    },
  },
  // OpenCode with an OpenAI-compatible provider and edits that ask (OpenCode 2's rules).
  opencode: {
    npm: 'opencode-ai',
    bin: 'opencode',
    tty: true,
    tool: file => ({ name: 'write', args: { path: file, content: 'hi' } }),
    run: async at => {
      const provider = { fake: { npm: '@ai-sdk/openai-compatible', name: 'fake', options: { baseURL: `${at.model}/v1`, apiKey: 'test' }, models: { fake: { name: 'fake' } } } }
      return { args: [], env: { OPENCODE_EXTRA: JSON.stringify({ provider, model: 'fake/fake', permissions: ['edit', 'write'].map(action => ({ action, resource: '*', effect: 'ask' })) }) } }
    },
  },
  // Codex in a read-only sandbox: a file change asks first (exec never asks).
  codex: {
    npm: '@openai/codex',
    bin: 'codex',
    tty: true,
    // A patch through the command tool, which Codex takes as apply_patch: a file change asks in the
    // relay (a command outside the sandbox asks in the terminal only).
    tool: file => ({ name: 'exec_command', args: { cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${file}\n+hi\n*** End Patch\nEOF\n` } }),
    run: async (at, cli) => {
      const codexHome = join(at.home, '.codex')
      const project = JSON.stringify(at.project)
      write(
        join(codexHome, 'config.toml'),
        [
          'model = "fake"',
          'model_provider = "fake"',
          'approval_policy = "on-request"',
          'sandbox_mode = "read-only"',
          'check_for_update_on_startup = false',
          '[model_providers.fake]',
          'name = "fake"',
          `base_url = "${at.model}/v1"`,
          'wire_api = "responses"',
          `[projects.${project}]`,
          'trust_level = "trusted"',
          '',
        ].join('\n'),
      )
      const env = { ...at.env, CODEX_HOME: codexHome }
      const trusted = await trustCodexHook(cli, codexHookOverrides(at.hook), codexHookCommand(at.hook) ?? '', at.project, env)
      if (!trusted) throw new Error('Codex did not record the hooks as trusted')
      return { args: [], env: { CODEX_HOME: codexHome } }
    },
  },
  // Gemini through Switchboard's extension, linked with Gemini's own command; no tool call.
  gemini: {
    npm: '@google/gemini-cli',
    bin: 'gemini',
    tool: null,
    run: async (at, cli) => {
      write(join(at.home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, general: { disableAutoUpdate: true } }))
      write(join(at.home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [at.project]: 'TRUST_FOLDER' }))
      const folder = join(at.home, '.claude-ide', 'agents', 'gemini-extension')
      const shared = serverFor(at.node, at.hook.args[0]!.replace(/hook\.mjs$/, 'server.mjs'), 'gemini', '', at.env.CLAUDE_IDE_SOCKET)
      for (const f of geminiExtension(shared, at.hook, folder)) write(f.path, `${JSON.stringify(f.value)}\n`)
      if (!(await linkGeminiExtension(cli, folder, at.env))) throw new Error('gemini extensions link did not link the extension')
      const run = geminiRun(join(at.home, '.claude-ide', 'agents', `${at.terminal}-gemini.toml`), ['turnEnd', 'activity', 'prompt'])
      for (const f of run.files) write(f.path, f.content)
      return { args: [...run.args, '-p', PROMPT], env: { ...run.env, GEMINI_API_KEY: 'test', GOOGLE_GEMINI_BASE_URL: at.model } }
    },
  },
}

// How to start the CLI: the given command, the npm package's entry run with node (a Windows .cmd
// shim cannot start without a shell), or its name on PATH.
function cliCommand(spec: Spec, given: string[]): string[] {
  if (given.length > 0) return given
  const npmRoot = spawnSync(WINDOWS ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: WINDOWS }).stdout.trim()
  const pkg = join(npmRoot, ...spec.npm.split('/'))
  if (existsSync(join(pkg, 'package.json'))) {
    const bin = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }).bin
    const entry = typeof bin === 'string' ? bin : bin?.[spec.bin]
    if (entry) {
      const path = join(pkg, entry)
      // A package whose entry is the native program itself.
      const head = readFileSync(path).subarray(0, 2).toString()
      return head === '#!' || /\.[cm]?js$/.test(path) ? [process.execPath, path] : [path]
    }
  }
  if (WINDOWS) {
    const shim = spawnSync('where.exe', [`${spec.bin}.cmd`], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0]?.trim()
    const script = shim ? npmShimScript(shim, readFileSync(shim, 'utf8')) : null
    if (script) return [process.execPath, script]
  }
  return [spec.bin]
}

async function main(): Promise<number> {
  const agent = process.argv[2] ?? ''
  const spec = SPECS[agent]
  const preset = agent === 'gemini' ? null : presetOf(agent)
  if (!spec || (agent !== 'gemini' && !preset)) throw new Error(`unknown agent: ${agent} (${Object.keys(SPECS).join(', ')})`)
  const cli = cliCommand(spec, process.argv.slice(3))
  const version = spawnSync(cli[0]!, [...cli.slice(1), '--version'], { encoding: 'utf8', timeout: 60000 }).stdout?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null
  console.log(`${agent} ${version ?? 'unknown'}: ${cli.join(' ')}`)
  // The hook's socket is under HOME, and macOS's own temporary folder (/var/folders/...) is long
  // enough to pass the socket path limit (about 104 bytes), where the app sends nothing away.
  if (!WINDOWS) process.env.TMPDIR = '/tmp'
  const { work, home, env } = testHome('sb-relay-')
  const project = join(realpathSync(work), 'proj')
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '-q', project])
  const file = join(project, 'hello.txt')
  // The app's Node side in a folder whose name holds a space.
  const nodeDir = join(work, 'app dir', 'node')
  cpSync(join(ROOT, 'out', 'node'), nodeDir, { recursive: true })
  const appKey = randomBytes(32).toString('hex')
  const started: { kill: () => void; running: () => boolean }[] = []
  const tool = spec.tool?.(file) ?? null
  const model = await fakeModel(tool)
  let failed = ''
  try {
    const bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'server.ts')], { cwd: ROOT, env: { ...env, SWITCHBOARD_APP_KEY_STDIN: '1' }, stdio: ['pipe', 'ignore', 'inherit'] })
    started.push({ kill: () => bridge.kill(), running: () => bridge.exitCode === null })
    bridge.stdin!.end(`${appKey}\n`)
    await until('the bridge', async () => (await app(env, home, appKey, 'GET', '/health')).status === 200, 20000)
    await app(env, home, appKey, 'POST', '/presence', { away: true })

    // The run as the app opens it (src/main/agentTerms.ts), without the shell line.
    const terminal = randomBytes(16).toString('hex')
    const hook = { command: process.execPath, args: [join(nodeDir, 'mcp', 'hook.mjs'), agent] }
    const at: At = { work, home, project, file, model: model.url, terminal, node: process.execPath, hook, env }
    const own = await spec.run(at, cli)
    let args = own.args
    let runEnv: Record<string, string> = {}
    if (preset) {
      if (!hookAttaches(preset, hook, version)) throw new Error(`no hook for ${agent} ${version} on ${process.platform}`)
      const abilities = ['approvals', 'turnEnd', 'activity', ...(['qwen', 'codex'].includes(agent) ? ['prompt'] : [])]
      const server = serverFor(process.execPath, join(nodeDir, 'mcp', 'server.mjs'), agent, terminal, env.CLAUDE_IDE_SOCKET, undefined, abilities)
      const configFile = preset.dataFolder ? join(home, '.claude-ide', 'agents', agent, 'p0', `${agent}.json`) : join(home, '.claude-ide', 'agents', `${terminal}-${agent}.json`)
      const run = presetRun(preset, server, configFile, process.platform, hook, version)
      for (const f of run.files) write(f.path, f.content)
      runEnv = run.env
      args = [...run.args, ...own.args]
    }
    // OpenCode reads one config from the env: the app's, with this script's model.
    if (own.env.OPENCODE_EXTRA) {
      runEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...(JSON.parse(runEnv.OPENCODE_CONFIG_CONTENT ?? '{}') as object), ...(JSON.parse(own.env.OPENCODE_EXTRA) as object) })
      delete own.env.OPENCODE_EXTRA
    }

    // PWD too: OpenCode takes its project from it, not from the working folder.
    const childEnv = { ...env, ...runEnv, ...own.env, SWITCHBOARD_TERMINAL: terminal, PWD: project }
    let output = ''
    let exit: number | null | undefined
    // A terminal's screen, as the app's terminal would show it, for the failure message.
    let screen = () => ''
    if (spec.tty) {
      const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')
      const view = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
      screen = () => {
        const lines: string[] = []
        for (let y = 0; y < view.buffer.active.length; y++) lines.push(view.buffer.active.getLine(y)?.translateToString(true) ?? '')
        return lines.filter(line => line.trim()).slice(-40).join('\n')
      }
      const term = pty.spawn(cli[0]!, [...cli.slice(1), ...args], { name: 'xterm-256color', cols: 120, rows: 40, cwd: project, env: childEnv as Record<string, string> })
      started.push({ kill: () => term.kill(), running: () => exit === undefined })
      term.onData(data => view.write(data))
      term.onExit(({ exitCode }) => (exit = exitCode))
      // The prompt, typed again until the model is asked: the first may land before the CLI reads keys.
      const typing = setInterval(() => {
        if (model.asked() > 0 || exit !== undefined) return clearInterval(typing)
        term.write(PROMPT)
        setTimeout(() => term.write('\r'), 500)
      }, 5000)
    } else {
      const child = spawn(cli[0]!, [...cli.slice(1), ...args], { cwd: project, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      started.push({ kill: () => child.kill(), running: () => child.exitCode === null })
      child.stdout!.on('data', chunk => (output += chunk))
      child.stderr!.on('data', chunk => (output += chunk))
      child.once('exit', code => (exit = code))
    }
    // A terminal's output without its escape codes.
    const tail = () => (spec.tty ? `\n${screen()}` : `\n${output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, ' ').replace(/[ \t]{2,}/g, ' ').slice(-2500)}`)
    const fail = (error: unknown): never => {
      throw new Error(`${error instanceof Error ? error.message : error}${tail()}`)
    }

    // The session the run's server registered, and what its hooks said of the turn.
    const state = async () => (await app(env, home, appKey, 'GET', '/state')).json
    const session = await until(
      'the session in the bridge',
      async () => {
        if (exit !== undefined) throw new Error(`the CLI ended (${exit})`)
        return ((await state()).sessions as { id: string; terminal?: string }[] | undefined)?.find(s => s.terminal === terminal)?.id
      },
      120000,
    ).catch(fail)
    const activity = async () => ((await state()).activity as Record<string, { state: string }> | undefined)?.[session]?.state
    await until('the turn start (working)', async () => model.asked() > 0 && (await activity()) === 'working', 120000).catch(async error =>
      fail(`${error instanceof Error ? error.message : error} (model asked ${model.asked()} times, activity ${await activity()})`),
    )
    console.log('turn start: the session is working before the model answered')
    model.open()

    if (tool) {
      const ask = await until(
        'the ask in the bridge queue',
        async () => ((await state()).approvals as { id: number; status: string; tool: string; summary: string }[] | undefined)?.find(a => a.status === 'pending'),
        120000,
      ).catch(fail)
      console.log(`ask ${ask.id}: ${ask.tool}, ${ask.summary.split('\n')[0]}`)
      if (!ask.summary.includes('hello.txt')) throw new Error(`the summary does not name the file: ${ask.summary}`)
      const answered = await app(env, home, appKey, 'POST', `/approvals/${ask.id}/answer`, { decision: 'allow', note: '' })
      if (answered.status !== 200) throw new Error(`answer: ${answered.status} ${JSON.stringify(answered.json)}`)
    }
    if (!spec.tty) await until('the CLI to end', () => exit !== undefined, 120000).catch(fail)
    await until('the turn end (idle)', async () => (await activity()) === 'idle', spec.tty ? 120000 : 30000).catch(fail)
    if (tool && !existsSync(file)) fail(`no hello.txt after allowing (exit ${exit})`)
    if (tool) console.log(`allowed, and ${agent} wrote hello.txt`)
    console.log('turn end: the session is idle again')
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error)
  } finally {
    for (const child of started.reverse()) if (child.running()) child.kill()
    model.close()
    // Windows keeps a file a stopped process held for a moment.
    await new Promise(r => setTimeout(r, 1500))
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  }
  if (failed) console.log(`FAILED: ${failed}`)
  return failed ? 1 : 0
}

process.exit(await main())
