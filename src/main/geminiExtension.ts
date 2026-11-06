// Gemini CLI 0.67 skips a system defaults file in a folder root does not own, so the run's own
// file (agents.ts, the Gemini preset) no longer reaches it. With the setting on (agents.ts
// GEMINI_EXTENSION_KEY), the app links Switchboard's extension (agents.ts geminiExtension) into the
// person's Gemini folder with Gemini's own command, as `gemini extensions link` would by hand. The
// extension lives in the app's folder: the link only points there. One of the same name that is not
// this link is left alone, and Gemini then opens without Switchboard's.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GEMINI_EXTENSION } from '../shared/agents'

// Where Gemini keeps the extension's install record: GEMINI_CLI_HOME stands for the home when set.
export function installRecord(env: NodeJS.ProcessEnv): string {
  return join(env.GEMINI_CLI_HOME || env.HOME || homedir(), '.gemini', 'extensions', GEMINI_EXTENSION, '.gemini-extension-install.json')
}

// 'ours': linked to `folder`; 'other': an extension of that name from elsewhere; 'none'.
export function linkState(record: string | null, folder: string): 'ours' | 'other' | 'none' {
  if (record === null) return 'none'
  try {
    const parsed = JSON.parse(record) as { source?: unknown; type?: unknown }
    return parsed.type === 'link' && parsed.source === folder ? 'ours' : 'other'
  } catch {
    return 'other'
  }
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// `gemini`: how to start it (agentDetect.ts cliBins). True once the link points at `folder`.
export function linkGeminiExtension(gemini: string[], folder: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<boolean> {
  const state = linkState(read(installRecord(env)), folder)
  if (state !== 'none') return Promise.resolve(state === 'ours')
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(linkState(read(installRecord(env)), folder) === 'ours')
    }
    // --consent: the person agreed in the app's settings; stdin closed, so nothing waits on a prompt.
    const child = spawn(gemini[0]!, [...gemini.slice(1), 'extensions', 'link', folder, '--consent'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
    const timer = setTimeout(finish, timeoutMs)
    child.on('error', finish)
    child.on('exit', finish)
  })
}
