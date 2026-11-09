// Several logins (accounts) per agent CLI (docs/계정-여러-개.md). Each account past the first has
// its own home folder, which the CLI's home env var points at when it starts; account 1 is the
// person's own login, in the CLI's usual home. Every account shares the default home's history,
// so a conversation goes on on another account.

export type AccountSpec = {
  agent: string
  // The env that points the CLI at an account's home. `base`: the default home, for a CLI that
  // keeps its history apart from its login (Qwen's runtime folder).
  env: (home: string, base: string) => Record<string, string>
  // Signs in on the account: run in a terminal whose env is the account's.
  login: string[]
  // Folders in the default home every account uses, linked from the account's home. Never a
  // SQLite file: its WAL file would sit beside the link, one per account, for one database.
  shared: string[]
  // Files copied from the default home at each start when they changed there: a link would break
  // when the CLI saves by writing a new file.
  copied: string[]
  // Files whose presence says the account signed in. Only looked for, never read: some hold tokens.
  // Claude Code keeps its login in the keychain on macOS: its account is read from .claude.json.
  signedIn: string[]
  // The text the CLI shows at the end of its screen when the account's plan runs out, for a CLI
  // that sends no usage report (src/main/accountRotate.ts), checked with the real CLI by
  // scripts/account-check.ts --limit. Claude Code and Codex report their usage instead. Absent
  // (Copilot): no way found to check it, so a Copilot session is not moved by itself.
  limit?: RegExp
}

export const ACCOUNT_SPECS: AccountSpec[] = [
  {
    agent: 'claude',
    env: home => ({ CLAUDE_CONFIG_DIR: home }),
    login: ['claude', 'auth', 'login'],
    shared: ['projects', 'todos', 'file-history', 'plans', 'shell-snapshots', 'session-env', 'paste-cache', 'tasks', 'transcripts', 'agents', 'commands', 'skills', 'rules'],
    copied: ['settings.json', 'CLAUDE.md'],
    signedIn: [],
  },
  {
    agent: 'codex',
    env: home => ({ CODEX_HOME: home }),
    login: ['codex', 'login'],
    shared: ['sessions', 'archived_sessions', 'prompts', 'skills', 'rules'],
    copied: ['config.toml', 'AGENTS.md'],
    signedIn: ['auth.json'],
  },
  {
    agent: 'gemini',
    env: home => ({ GEMINI_CLI_HOME: home }),
    login: ['gemini'],
    shared: ['.gemini/tmp', '.gemini/extensions'],
    copied: ['.gemini/settings.json', '.gemini/GEMINI.md', '.gemini/projects.json'],
    signedIn: ['.gemini/oauth_creds.json'],
    limit: /exhausted your daily quota|Usage limit reached for/,
  },
  {
    agent: 'qwen',
    env: (home, base) => ({ QWEN_HOME: home, QWEN_RUNTIME_DIR: base }),
    login: ['qwen'],
    shared: [],
    copied: [],
    signedIn: ['settings.json'],
    limit: /Quota exhausted: /,
  },
  {
    agent: 'copilot',
    env: home => ({ COPILOT_HOME: home }),
    login: ['copilot', 'login'],
    shared: ['session-state'],
    copied: [],
    signedIn: ['config.json'],
  },
]

export const accountSpec = (agent: string | undefined): AccountSpec | undefined => ACCOUNT_SPECS.find(s => s.agent === agent)

// One account the person added: its number (2 and up; 1 is the default login) and a name of theirs.
export type AccountEntry = { id: number; name: string }
export type AccountList = Record<string, AccountEntry[]>

// What the app keeps, cleaned: known agents only, whole numbers from 2, each once, in order.
export function accountList(value: unknown): AccountList {
  const out: AccountList = {}
  if (!value || typeof value !== 'object') return out
  for (const spec of ACCOUNT_SPECS) {
    const raw = (value as Record<string, unknown>)[spec.agent]
    if (!Array.isArray(raw)) continue
    const seen = new Set<number>()
    const entries: AccountEntry[] = []
    for (const item of raw) {
      const id = Number((item as { id?: unknown })?.id)
      if (!Number.isInteger(id) || id < 2 || id > 99 || seen.has(id)) continue
      seen.add(id)
      const name = (item as { name?: unknown }).name
      entries.push({ id, name: typeof name === 'string' ? name.slice(0, 60) : '' })
    }
    if (entries.length > 0) out[spec.agent] = entries.sort((a, b) => a.id - b.id)
  }
  return out
}

// The next free number for an agent's new account.
export function nextAccountId(list: AccountList, agent: string): number {
  const used = new Set((list[agent] ?? []).map(e => e.id))
  let id = 2
  while (used.has(id)) id += 1
  return id
}

// When each account's limit lifts, epoch ms: agent → account → time.
export type AccountLimits = Record<string, Record<string, number>>

export function limitsOf(value: unknown, now: number): AccountLimits {
  const out: AccountLimits = {}
  if (!value || typeof value !== 'object') return out
  for (const [agent, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!accountSpec(agent) || !raw || typeof raw !== 'object') continue
    for (const [id, until] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof until === 'number' && until > now && /^\d+$/.test(id)) (out[agent] ??= {})[id] = until
    }
  }
  return out
}

// The account a new session of the agent starts on: the first signed in one whose limit is not
// holding, from `after` on when it is given (the one a limit moves a session off), wrapping round.
// Null when every account is held, or the agent has no extra accounts (the CLI's own login then).
export function pickAccount(ids: number[], signedIn: (id: number) => boolean, limits: Record<string, number> | undefined, now: number, after?: number): number | null {
  if (ids.length < 2) return null
  const start = after === undefined ? 0 : ids.indexOf(after) + 1
  const order = after === undefined ? ids : [...ids.slice(start), ...ids.slice(0, start)].filter(id => id !== after)
  return order.find(id => signedIn(id) && !((limits?.[String(id)] ?? 0) > now)) ?? null
}

// How long a limit the terminal showed is taken to hold: the screen's own reset time is not read.
export const SCREEN_LIMIT_MS = 3600_000
