// A conversation goes on on another account of the same CLI (docs/계정-여러-개.md), with the real
// CLI: a turn on the default account, then the CLI started the way the app starts it on account 2
// (src/main/accounts.ts: the account's home, made ready from the default one, and its env), going
// on with that conversation. A model server of this script's own stands in for every account, so
// no sign-in is needed, and tells whether the second turn carried the first one.
//
//   npx -y jiti@2.6.1 scripts/account-check.ts <claude|codex|gemini|qwen|copilot> [--limit] [command...]
//
// --limit (Gemini, Qwen): the limit text the app looks for on the screen, and its Ctrl-C (limitCheck).
//
// The command defaults to the CLI's npm package installed globally, or else its name on PATH. Everything lives in a temporary folder.

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import { accountSpec } from '../src/shared/accounts'
import { EXIT_PRESS_MS, EXIT_PRESSES, screenLimited } from '../src/main/accountRotate'
import { defaultBase, envOf, homeOf, type AccountPaths } from '../src/main/accounts'
import { cliCommand } from './cli-path.ts'
import { testHome, until, type Env } from './tauri-smoke.ts'

const FIRST = 'remember the word pumpkin'
const SECOND = 'which word was it'

// Answers every request with text, and keeps what each one sent.
// `limited`: every turn is refused as the plan's limit would refuse it, in the CLI's own wire.
function fakeModel(limited = false): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      if (process.env.ACCOUNT_DEBUG) console.log('model:', req.method, url, body.slice(0, 200))
      let json: Record<string, unknown> = {}
      try {
        json = JSON.parse(body || '{}') as Record<string, unknown>
      } catch {
        // an empty request
      }
      const send = (type: string, value: unknown) => {
        res.setHeader('content-type', type)
        res.end(typeof value === 'string' ? value : JSON.stringify(value))
      }
      const text = (value: unknown) => JSON.stringify(value)
      if (url.includes(':countTokens') || url.includes('count_tokens')) return send('application/json', { totalTokens: 1, input_tokens: 1 })
      if (!/chat\/completions|\/responses|:generateContent|:streamGenerateContent|\/v1\/messages/.test(url)) return send('application/json', { data: [{ id: 'fake', object: 'model' }] })
      bodies.push(body)
      if (limited) {
        res.statusCode = 429
        if (/generateContent|streamGenerateContent/.test(url)) {
          // A daily quota, which Gemini takes as one that will not lift by retrying.
          const violations = [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }]
          return send('application/json', { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations }] } })
        }
        return send('application/json', { error: { message: 'Your quota has been exceeded. It will reset at 10:00.', type: 'insufficient_quota', code: 'insufficient_quota' } })
      }
      if (url.includes('/v1/messages')) {
        const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } }
        if (!json.stream) return send('application/json', { ...message, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
        const event = (type: string, data: object) => `event: ${type}\ndata: ${text({ type, ...data })}\n\n`
        return send(
          'text/event-stream',
          event('message_start', { message }) +
            event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
            event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
            event('content_block_stop', { index: 0 }) +
            event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
            event('message_stop', {}),
        )
      }
      if (url.includes('chat/completions')) {
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        if (!json.stream) return send('application/json', { id: 'c1', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage })
        const chunk = (choice: unknown) => `data: ${text({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [choice], usage })}\n\n`
        return send('text/event-stream', chunk({ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }) + chunk({ index: 0, delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n')
      }
      if (url.includes('/responses')) {
        const item = { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
        const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
        const event = (type: string, data: object) => `event: ${type}\ndata: ${text({ type, ...data })}\n\n`
        return send(
          'text/event-stream',
          event('response.created', { response: { id: 'resp_1' } }) +
            event('response.output_item.added', { output_index: 0, item }) +
            event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' }) +
            event('response.output_item.done', { output_index: 0, item }) +
            event('response.completed', { response: { id: 'resp_1', usage } }),
        )
      }
      const config = (json.generationConfig ?? json.config ?? {}) as { responseMimeType?: string }
      const part = config.responseMimeType === 'application/json' ? { text: text({ next_speaker: 'user', reasoning: 'done' }) } : { text: 'ok' }
      const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: 'fake' }
      return url.includes('stream') ? send('text/event-stream', `data: ${text(chunk)}\n\n`) : send('application/json', chunk)
    })
  })
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      done({ url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() })
    }),
  )
}

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type At = { home: string; base: string; account: string; project: string; model: string }
// One CLI: what its default home needs for the fake model (written before the first turn), the
// env a run gets for it, what an account home needs that is not copied from the default one, and
// the args of the first turn and of going on with the last conversation.
type Spec = {
  npm: string
  setup: (at: At) => void
  env: (at: At) => Record<string, string>
  account?: (at: At) => void
  first: string[]
  again: string[]
}

const SPECS: Record<string, Spec> = {
  claude: {
    npm: '@anthropic-ai/claude-code',
    setup: () => undefined,
    env: at => ({ ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: at.model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }),
    first: ['-p', FIRST],
    again: ['-p', '--continue', SECOND],
  },
  codex: {
    npm: '@openai/codex',
    setup: at =>
      write(
        join(at.base, 'config.toml'),
        ['model = "fake"', 'model_provider = "fake"', 'check_for_update_on_startup = false', '[model_providers.fake]', 'name = "fake"', `base_url = "${at.model}/v1"`, 'wire_api = "responses"', `[projects.${JSON.stringify(at.project)}]`, 'trust_level = "trusted"', ''].join('\n'),
      ),
    env: () => ({}),
    first: ['exec', '--skip-git-repo-check', FIRST],
    again: ['exec', '--skip-git-repo-check', 'resume', '--last', SECOND],
  },
  gemini: {
    npm: '@google/gemini-cli',
    setup: at => {
      write(join(at.base, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, general: { disableAutoUpdate: true } }))
      write(join(at.base, '.gemini', 'trustedFolders.json'), JSON.stringify({ [at.project]: 'TRUST_FOLDER' }))
    },
    env: at => ({ GEMINI_API_KEY: 'test', GOOGLE_GEMINI_BASE_URL: at.model }),
    // The folder trust is the account's own file.
    account: at => write(join(at.account, '.gemini', 'trustedFolders.json'), JSON.stringify({ [at.project]: 'TRUST_FOLDER' })),
    first: ['-p', FIRST],
    again: ['--resume', 'latest', '-p', SECOND],
  },
  qwen: {
    npm: '@qwen-code/qwen-code',
    setup: at => write(join(at.base, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'fake' }, general: { disableAutoUpdate: true } })),
    env: at => ({ OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `${at.model}/v1`, OPENAI_MODEL: 'fake' }),
    // Qwen's settings hold the account's own login: the account gets its own.
    account: at => write(join(at.account, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'fake' }, general: { disableAutoUpdate: true } })),
    first: ['-p', FIRST],
    again: ['--continue', '-p', SECOND],
  },
  copilot: {
    npm: '@github/copilot',
    setup: () => undefined,
    env: at => ({ COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_PROVIDER_BASE_URL: `${at.model}/v1`, COPILOT_MODEL: 'gpt-4.1' }),
    first: ['-p', FIRST, '--allow-all-tools'],
    again: ['--continue', '-p', SECOND, '--allow-all-tools'],
  },
}

// --limit: the CLI in a terminal, as the app runs it, with every turn refused for the plan's limit.
// The end of its screen must show what src/shared/accounts.ts looks for, and Ctrl-C pressed the way
// the move to another account presses it (src/main/accountRotate.ts) must end it.
async function limitCheck(agent: string, spec: Spec, cli: string[], at: At, env: Env, model: { bodies: string[] }): Promise<boolean> {
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')
  const view = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  const rows = () => {
    const lines: string[] = []
    for (let y = 0; y < view.buffer.active.length; y++) lines.push(view.buffer.active.getLine(y)?.translateToString(true) ?? '')
    return lines
  }
  // Each CLI opens its terminal screen when started with no args.
  // A CLI that sees a CI run (Gemini 0.67 isHeadlessMode: CI or GITHUB_ACTIONS) takes its terminal
  // as no terminal at all.
  const ttyEnv: Env = { ...env, ...spec.env(at) }
  for (const name of Object.keys(ttyEnv)) if (/^(CI|CONTINUOUS_INTEGRATION|CI_.*|GITHUB_ACTIONS)$/.test(name)) delete ttyEnv[name]
  const term = pty.spawn(cli[0]!, cli.slice(1), { name: 'xterm-256color', cols: 120, rows: 40, cwd: at.project, env: ttyEnv as Record<string, string> })
  let exit: number | undefined
  term.onData(data => view.write(data))
  term.onExit(({ exitCode }) => (exit = exitCode))
  const typing = setInterval(() => {
    if (model.bodies.length > 0 || exit !== undefined) return clearInterval(typing)
    term.write(FIRST)
    setTimeout(() => term.write('\r'), 500)
  }, 5000)
  try {
    await until('the limit text at the end of the screen', () => exit === undefined && screenLimited(agent, rows()), 120_000)
    console.log(`ok: the screen shows the limit:\n${rows().filter(r => r.trim()).slice(-8).join('\n')}`)
    for (let press = 0; press < EXIT_PRESSES && exit === undefined; press++) {
      term.write('\x03')
      await new Promise(r => setTimeout(r, EXIT_PRESS_MS))
    }
    await until('the CLI to end after Ctrl-C', () => exit !== undefined, 15_000)
    console.log('ok: Ctrl-C ended the CLI')
    return true
  } catch (error) {
    console.log(`FAILED: ${(error as Error).message} (model asked ${model.bodies.length} times)\n${rows().filter(r => r.trim()).slice(-25).join('\n')}`)
    return false
  } finally {
    clearInterval(typing)
    if (exit === undefined) term.kill()
  }
}

// The temporary folder goes; on Windows a CLI's child may still hold a file in it for a moment.
function leave(work: string): void {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch (error) {
    console.log(`left behind: ${work} (${(error as Error).message})`)
  }
}

async function main(): Promise<number> {
  const agent = process.argv[2] ?? ''
  const limit = process.argv[3] === '--limit'
  const spec = SPECS[agent]
  const account = accountSpec(agent)
  if (!spec || !account) throw new Error(`unknown agent: ${agent} (${Object.keys(SPECS).join(', ')})`)
  const cli = cliCommand(spec.npm, agent, process.argv.slice(limit ? 4 : 3))
  const { work, home, env: baseEnv } = testHome('sb-account-')
  const project = join(work, 'project')
  mkdirSync(project, { recursive: true })
  const model = await fakeModel(limit)
  const env: Env = { ...baseEnv, PWD: project }
  for (const name of ['CODEX_HOME', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'COPILOT_HOME', 'GITHUB_SHA']) delete env[name]
  // A CLI started from a Claude Code or Orca session would read that session's own settings.
  for (const name of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDECODE|ORCA_|ANTHROPIC_)/.test(name)) delete env[name]
  // Codex finds its home on Windows without USERPROFILE: the default account's home is named.
  if (agent === 'codex') env.CODEX_HOME = join(home, '.codex')
  const paths: AccountPaths = { root: join(home, '.claude-ide'), home, env, claudeDir: env.CLAUDE_CONFIG_DIR }
  const base = defaultBase(paths, agent)
  const at: At = { home, base, account: homeOf(paths, agent, 2), project, model: model.url }
  spec.setup(at)
  // Started apart from this process, which serves the model meanwhile.
  const run = (args: string[], extra: Record<string, string>) =>
    new Promise<boolean>(done => {
      const child = spawn(cli[0]!, [...cli.slice(1), ...args], { cwd: project, env: { ...env, ...spec.env(at), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', chunk => (out += chunk))
      child.stderr.on('data', chunk => (out += chunk))
      const timer = setTimeout(() => child.kill(), 120_000)
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) console.log(`exit ${code}\n${out.slice(-2500)}`)
        done(code === 0)
      })
    })
  let ok = false
  if (limit) {
    try {
      console.log(`${agent} --limit: ${cli.join(' ')}`)
      ok = await limitCheck(agent, spec, cli, at, env, model)
    } finally {
      model.close()
      leave(work)
    }
    return ok ? 0 : 1
  }
  try {
    console.log(`${agent}: ${cli.join(' ')}`)
    if (!(await run(spec.first, {}))) throw new Error('the first turn, on the default account, failed')
    const firstAsked = model.bodies.length
    if (!model.bodies.some(b => b.includes(FIRST))) throw new Error('the model never saw the first turn')
    // Account 2: its home made ready the way the app does it, and the env a run on it gets.
    // ACCOUNT_CHECK_UNSHARED=1: the account without the shared history, which must fail the check.
    const accountEnv = envOf(paths, process.env.ACCOUNT_CHECK_UNSHARED ? { ...account, shared: [], env: (h, b) => account.env(h, b === base && agent === 'qwen' ? h : b) } : account, 2)
    spec.account?.(at)
    if (!(await run(spec.again, accountEnv))) throw new Error('going on, on account 2, failed')
    const later = model.bodies.slice(firstAsked)
    if (!later.some(b => b.includes(SECOND))) throw new Error('the model never saw the turn on account 2')
    if (!later.some(b => b.includes(SECOND) && b.includes(FIRST))) throw new Error('the turn on account 2 did not carry the conversation of the default account')
    console.log(`ok: account 2 (${Object.keys(accountEnv).join(', ')}) went on with the conversation started on the default account`)
    ok = true
  } catch (error) {
    console.log(`FAILED: ${(error as Error).message}`)
  } finally {
    model.close()
    leave(work)
  }
  return ok ? 0 : 1
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error)
    process.exit(1)
  },
)
