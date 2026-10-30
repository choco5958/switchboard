// Loaded before every test (vitest setupFiles, node --import): tests never see the person's
// own accounts, sessions or bridge. Variables that point an agent CLI or the app at real
// state are removed, and HOME (USERPROFILE on Windows) is an empty folder of its own, so a
// function that falls back to homedir() reads nothing real (~/.claude, ~/.claude-acct,
// ~/.claude-ide). The folder goes when the test process ends.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_STATE = /^(ANTHROPIC_|CLAUDE|CCR_|OPENAI_|CODEX_|GEMINI_|GOOGLE_API_KEY$|SWITCHBOARD_)/

for (const key of Object.keys(process.env)) if (REAL_STATE.test(key)) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'switchboard-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
const removeHome = () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A file a child still holds open (Windows): the system's temp cleanup takes it.
  }
}
process.on('exit', removeHome)
// A vitest worker is stopped without its exit event: the file's own afterAll removes it there.
if (process.env.VITEST) {
  const { afterAll } = await import('vitest')
  afterAll(removeHome)
}
