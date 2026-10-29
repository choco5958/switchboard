// Loaded before every test (vitest setupFiles, node --import): tests never see the person's
// own accounts, sessions or bridge. Variables that point an agent CLI or the app at real
// state are removed, and HOME is an empty folder of its own, so a function that falls back
// to homedir() reads nothing real (~/.claude, ~/.claude-acct, ~/.claude-ide).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_STATE = /^(ANTHROPIC_|CLAUDE|CCR_|OPENAI_|CODEX_|GEMINI_|GOOGLE_API_KEY$|SWITCHBOARD_)/

for (const key of Object.keys(process.env)) if (REAL_STATE.test(key)) delete process.env[key]
process.env.HOME = mkdtempSync(join(tmpdir(), 'switchboard-test-home-'))
