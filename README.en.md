<div align="center">

<img src="resources/icon.png" width="112" alt="Switchboard icon">

# Switchboard

**A desktop app for directing many coding agents from one screen**

Claude Code, Codex and Gemini CLI sessions ask you for decisions, hand work to each other, and reach you on Telegram while you are away.

<a href="https://github.com/choco5958/switchboard/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/choco5958/switchboard?style=flat-square&color=6366f1"></a>
<a href="https://github.com/choco5958/switchboard/actions/workflows/test.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/choco5958/switchboard/test.yml?branch=main&style=flat-square&label=tests"></a>
<img alt="macOS | Windows | Linux" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-0f1424?style=flat-square&logo=electron&logoColor=9feaf9">
<a href="LICENSE"><img alt="MIT" src="https://img.shields.io/github/license/choco5958/switchboard?style=flat-square&color=22c55e"></a>

<p><b>Download</b> &nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">macOS</a> &nbsp;|&nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">Windows</a> &nbsp;|&nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">Linux</a></p>

[한국어](README.md) | **English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

</div>

<br>

![Home: tasks by project, decision queue, work log](docs/screenshot-home.png)

When a session needs a decision from you, it posts the question to a decision queue and keeps working instead of stopping. You answer with a key press, and the answer goes back to that session as a prompt. Sessions can also hand work to each other, and while you are away, decisions and permission asks reach you on Telegram.

## At a glance

<table>
<tr>
<td width="50%" valign="top">
<h3>🗳️ Decision queue</h3>
<p>A session posts its question and keeps working. Answer with one key, and the answer goes to that session as a prompt.</p>
</td>
<td width="50%" valign="top">
<h3>🤝 Sessions working together</h3>
<p>Sessions ask each other and get answers back. Replies from several sessions arrive together, and a request can be called off midway.</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>📱 While you are away</h3>
<p>Answer decisions and Claude Code's permission asks from Telegram or your phone's browser. Scheduled prompts run at the times you set.</p>
</td>
<td width="50%" valign="top">
<h3>🔍 Fix what you see</h3>
<p>Click an element in the built-in browser to leave a comment; its place, a screenshot and console errors go with it. Sessions click through local pages themselves to check.</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>🧩 Many coding CLIs</h3>
<p>Codex, Gemini CLI, Qwen Code, Copilot CLI, OpenCode, Goose and Amp join the same decision queue and task reports.</p>
</td>
<td width="50%" valign="top">
<h3>🎨 Your screen</h3>
<p>13 themes and 4 languages. Claude usage and context use sit at the top.</p>
</td>
</tr>
</table>

## Quick start

1. Get the installer for your system from [Releases](https://github.com/choco5958/switchboard/releases/latest) and open it. Details are under [Install](#install).
2. Open a session with `+ Claude` in the dock at the bottom and give it work as usual.
3. When a decision comes in, answer with a key. The session carries on from there.

## Features

### Decisions and tasks

- **Decision queue**: a session posts options, a recommendation and the reason for it with `ask_decision`. Pick with keys such as `a` or `b` and send with `Enter`. You can also hold a question or answer with a note. The same question is never queued twice.
- **Tasks and progress graph**: task stages (request, design, work, done) and nodes (check, build, test, review) are drawn on screen, with the subagent working on each node and whether it is running or finished.
- **Waiting for you**: tasks with an open decision, a turn stalled for more than 5 minutes, a usage limit, or a dropped session gather at the top of the sidebar. Stalled sessions and sessions whose limit has reset also raise a macOS notification.
- **Per-project view**: pick a folder on the left and the whole screen shows only that project's sessions and tasks.

### Sessions working together

- **Ask and answer**: a session finds others with `list_sessions` and sends a request with `send_to_session`. If the receiving session ends its turn without replying, its last answer goes back as the result.
- **Asking several sessions**: answers to a question sent to several sessions are gathered into one turn. If the person writes to the asking session from the app or its terminal in the meantime, the answers so far go in with that turn; after 15 minutes, the answers that came go in without the rest.
- **When no answer is coming**: if the receiving session disconnects or its turn is interrupted, the sender is told no answer is coming, so it carries on instead of waiting.
- **Cancelling and the hand-off cap**: a session takes back requests it gave with `cancel_request`. One not delivered yet never goes in; if the receiving session's turn works on that request alone, the turn stops. Requests handed between sessions that start from one request are capped at 8 in all.
- **Forward a decision**: you can forward a decision question to another session and let it answer.
- **Usage limits**: answers and messages for a session that has hit its usage limit are held until the limit resets, then delivered.

### While you are away

- **Answer on Telegram**: when the app is closed, the screen is locked, or there has been no input for more than 5 minutes, decision questions go to your own Telegram bot. Answer with a button or a reply.
- **Permission relay**: in the same situations, Claude Code's permission asks also come to the app and to Telegram. Allowing from Telegram takes a second tap. At your desk, the terminal asks as usual.
- **Phone browser**: from a phone on the same Wi-Fi (or Tailscale), answer decisions, allow or deny permission asks, see tasks and write to sessions. There is nothing to install; add it to the home screen to open it like an app. Opened over Tailscale HTTPS, it also notifies you of new questions.
- **Scheduled prompts**: daily, weekdays, every N minutes, or once, a prompt goes to a project's session. If no session is connected, the app opens a `+ Claude` terminal. Runs with nothing to report send no notification.

### Fixing what you see (live debugging)

- Register a dev server, start it, and open it in the in-app browser.
- Click an element on the page to leave a comment. The session receives it with the position, CSS, a screenshot, and the page's console errors and failed requests at that moment.
- Sessions read, click and type on local pages with the `browser_*` tools to check their own fixes. Only addresses on this computer or the private network are allowed.
- Local addresses that a CLI opens from an app terminal open in the in-app browser.

### Terminals and the shell

- **Built-in terminals**: `+ Claude` in the dock at the bottom opens Claude Code with the mod connected; `+ Shell` opens a plain shell.
- **Other coding CLIs**: Codex, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Goose and Amp also connect to the decision queue and task reports. The app attaches its MCP server through launch options, so each CLI's config files stay untouched. Cursor CLI, Grok, Kimi and Crush open as plain terminals, and any other CLI can be registered in Settings. Only installed CLIs appear in the dock.
- **`switchboard` command**: hand a session work from a shell or script and get the result back, with the outcome also reported as an exit code.
- **Session-side pane**: type `/switchboard` in Claude Code to see this session's task flow and open decisions in a side pane.

### Display

- The top bar shows Claude's 5-hour and weekly usage and context usage.
- Korean, English, Japanese and Simplified Chinese. It follows the OS language at first; change it in Settings.
- 13 themes: Classic navy, Adventure journal, Phosphor terminal, Pixel dots, Subway map, Circuit board, Modern terminal, Blue DOS window, Dracula, Nord, Solarized Dark and Light, GitHub Light.
- With Orca installed, each node can get its own worktree, and a Linear issue can start a task.



## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshot-decision.png" alt="Decision queue: Blue DOS window theme"><p align="center"><sub>Decision queue: Blue DOS window theme</sub></p></td>
<td width="50%"><img src="docs/screenshot-task.png" alt="Task view: stages and progress graph"><p align="center"><sub>Task view: stages and progress graph</sub></p></td>
</tr>
</table>

## Architecture

```mermaid
flowchart LR
  cc["Claude Code<br/>session"] -- "mod: ide-bridge" --> bridge
  cli["Codex, Gemini, ..."] -- "MCP: mcp/server.ts" --> bridge
  cmd["switchboard<br/>command"] --> bridge
  tg["Telegram bot"] <-->|"long polling"| bridge
  bridge[("Bridge<br/>local socket + SQLite")] <--> app["Switchboard app<br/>Electron"]
```

| Folder | Role |
| --- | --- |
| `bridge/` | Local relay server using the `~/.claude-ide/bridge.sock` socket and the `~/.claude-ide/ide.db` SQLite database. It opens no network port. Scheduled runs and the Telegram connection also run here. |
| `mod/` | The Claude Code mod `ide-bridge`. It registers the tools, puts answers from the app into the session, and draws the `/switchboard` pane. |
| `mcp/` | MCP server (stdio) for other coding CLIs: the same tools as the mod, plus `check_answers`. |
| `scripts/` | The setup script and the `switchboard` command. |
| `src/` | The Electron app (React). |

## Requirements

- macOS, Windows or Linux. Tested on macOS (Apple Silicon); Windows and Linux have passed the automated tests but are not yet tried on a real machine.
- Claude Code 2.1.309 or later (for mod support)
- Optional: other coding CLIs such as Codex or Gemini CLI, Orca (worktrees, Linear), a Telegram account
- Only to run from source: Node.js 24 or later, pnpm

## Install

### Installers

Download the file for your system from [Releases](https://github.com/choco5958/switchboard/releases/latest). The app carries its own Node, so there is nothing else to install.

| System | File |
| --- | --- |
| macOS | `Switchboard-<version>-mac-arm64.dmg` for Apple Silicon, `-mac-x64.dmg` for Intel |
| Windows | `Switchboard-<version>-win-x64.exe` (`-win-arm64.exe` on ARM devices) |
| Linux | `.AppImage` (make it executable and run it) or `.deb` |

The app is not code-signed yet, so the first open shows a warning.

- macOS: move the app to Applications, right-click it and choose Open, then Open again in the dialog.
- Windows: in the "Windows protected your PC" dialog, click More info, then Run anyway.

At each start the app rewrites the bridge start files and the `switchboard` command in `~/.claude-ide` to match where it is. The `switchboard` command lands in `~/.local/bin` on macOS and Linux and in `%USERPROFILE%\.claude-ide\bin` on Windows; add that folder to your PATH.

The app checks for new versions by itself. Windows and Linux (AppImage) download a new version and install it when the app quits. macOS cannot install an unsigned update, so there a notification opens the download page.

### From source

```sh
git clone https://github.com/choco5958/switchboard.git
cd switchboard
pnpm install
pnpm run setup  # writes ~/.claude-ide/start-bridge.json and ~/.local/bin/switchboard
pnpm dev        # run the app
```

Run `pnpm run setup` again if you move the repo folder. `pnpm dist` builds the installers.

### Claude Code in other terminals

The app's `+ Claude` terminal loads the mod by itself. To connect Claude Code sessions started in other terminals too, install the mod from the Claude Code prompt:

```
/plugin install ide-bridge --marketplace choco5958/switchboard
```

Answer `y` to `Add marketplace?` and choose the first scope, user. From a shell: `claude plugin install ide-bridge --marketplace choco5958/switchboard`.

Sessions started after the install connect to the bridge. If the bridge is not running, the mod or the app starts it. The mod starts it with the `~/.claude-ide/start-bridge.json` that the app or `pnpm run setup` writes, so start the app once or run setup first.

## Usage

1. Start the app and click `+ Claude` in the dock. The first time, choose a project folder with `+ Folder` at the top left.
2. Give Claude Code work as usual. The tool descriptions say when to use them, so the session posts its task on its own and asks when it needs a decision.
3. A number on the question-mark icon on the left means a decision is waiting. Open it and answer with a key.

### Keys

| Key | Action |
| --- | --- |
| `a`, `b`, `1`, `2` | Pick an option |
| `Enter` | Send |
| `H` | Hold |
| `M` | Write a note (`Cmd+Enter` to send, `Esc` to leave) |
| `Cmd+K` | Find (open a task, ask for a progress report, and so on) |

### Connecting Telegram

1. In Telegram, send `/newbot` to `@BotFather` and choose a name and username for the bot.
2. In Switchboard, open Settings > Answer on Telegram, paste the token BotFather gave you (it looks like `123456:ABC...`), and click Connect bot.
3. Click Get a link code and, within 10 minutes, open the link on your phone and tap Start. Only that chat is connected; answers from anyone else are refused.

The bridge asks Telegram's servers for new messages itself, so there is no port to open.

### Phone access

1. In Settings > Phone access, turn on `Turn on phone access`. If macOS asks whether to accept incoming connections, choose Allow.
2. Pick the address the phone opens, type a name for the phone and press `Show a QR code`. On macOS the default is `This computer's name` (`name.local`), which stays when the router hands the computer another address, so the phone does not need pairing again.
3. Scan the QR code with the phone's camera and open it. Add it to the home screen from the browser's share menu to open it like an app.

Each phone connects on its own, and `Disconnect` in Settings ends one at any time.

**Notifications, and away from home**: with [Tailscale](https://tailscale.com) installed and signed in on the computer and the phone, Settings offers `Turn on Tailscale HTTPS`. It has Tailscale make an HTTPS address under this computer's name, open on your tailnet only. Pair through that address to use the page anywhere, and press `Get notifications on this phone` at the bottom to hear about new decisions and permission asks while you are away. On iPhone, add the page to the home screen and open it from there before turning notifications on. A page opened over plain HTTP announces new items only while it is open, with a buzz and a count in its title.

Turn off `Accept phones on the same Wi-Fi` to listen on this computer only, for Tailscale HTTPS alone. macOS then does not ask about the firewall either.

### Scheduled prompts

In Settings > Scheduled prompts, set a name, project, prompt and schedule. Intervals are 5 minutes or longer. A run is skipped while the previous one is still going. For runs missed while the app or bridge was off, you choose whether to run them once on startup.

### Shell command

| Command | What it does |
| --- | --- |
| `switchboard sessions` | List sessions (● connected) |
| `switchboard send <session or project> <work or -> [--wait] [--timeout 30m] [--info] [--json]` | Hand a session work and print an id such as `m7`. With `--wait` it waits for the result and prints it; `--info` sends a notice that expects no reply. `-` reads from standard input. |
| `switchboard status m7` | Status and result of work you handed over |
| `switchboard decisions`, `switchboard answer Q12 a [note]` | List open decisions and answer one |
| `switchboard waits`, `switchboard fire w3 [payload]` | List waits a session has opened and wake one |

Exit codes: 0 done, 1 failed, 2 usage error, 3 the session is waiting on a decision, 4 timed out (the session keeps working), 5 the bridge is down or there is no such session.

```sh
# Wake the session waiting on the test run when it finishes
pnpm test; switchboard fire w3 "tests finished: exit code $?"
```

## Tools sessions use

| Tool | What it does |
| --- | --- |
| `ask_decision` | Posts a question to the decision queue and returns right away without waiting. |
| `set_task` | Creates a task or updates its stage, current step and test results. |
| `plan_nodes`, `update_node` | Splits a task into nodes on the progress graph and changes their state (waiting, now, done, failed). |
| `node_worktree` | Creates an Orca worktree for a node. Requires Orca. |
| `open_in_ide` | Opens a page or dev server in the Live debugging tab. |
| `list_sessions`, `send_to_session` | Sees other sessions and sends them a request or information. The reply arrives on a later turn. |
| `cancel_request` | Cancels requests this session gave. If the receiving session's turn works on that request alone, the turn stops. |
| `await_event`, `close_wait` | Opens and closes a wait for outside work such as a build or a deploy. |
| `routine_no_update`, `routine_report_failure` | Records that a scheduled run had nothing to report, or that it failed. |
| `browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate`, `browser_console`, `browser_screenshot` | Read and drive local pages in the in-app browser. A click with a stale ref is refused. |
| `check_answers` | For other coding CLIs: a session running outside the app collects answers it has not received yet. |

## Data and security

- All data stays under `~/.claude-ide/` on this computer. The folder is readable only by you (0700), and so are the socket and database (0600).
- With Telegram connected, decision questions and permission asks pass through Telegram's servers. Values that look like credentials are masked before sending. The bot token is kept only in the database, never in the screen state.
- Console and request logs attached to screen comments are masked the same way as they are collected.
- The sessions' browser tools only open addresses on this computer or the private network.
- The scripts of the browser tools and screen comments run in a world of their own, apart from the page. The page's scripts cannot fake where a click lands or what is read, or save a comment in the person's place.
- Before typing a message into another CLI's terminal, the app checks the screen. While the CLI shows a confirmation menu such as "run this command?", it waits, so the typing never picks an option there.
- Answering permission asks, setting away status, setting up Telegram, scheduling prompts, changing settings and controlling sessions are for the app only. The app hands the bridge a key kept encrypted by the system keychain, on standard input, and these routes answer only that key. So a session with shell access that calls the bridge itself still cannot allow its own permission asks. A bridge a mod started first has no key, so the app starts it again once when it opens.
- Answering decision questions, sending messages to sessions and firing waits are what the `switchboard` command uses, so any program of the same user can do them. When you give an agent shell access, block `~/.claude-ide` with the Claude Code sandbox.
- A dev server command a session named through `open_in_ide` runs only after the app shows the command and its folder and you confirm, the first time and whenever it changes.
- Remote approvals show the command first. Asks that cannot be shown whole (cut, hidden characters, edits in several places) are asked in the terminal only, and asks with masked values cannot be allowed from Telegram.
- On Windows the bridge opens a port on 127.0.0.1 only and answers only requests carrying the token it makes at each start. Requests from web pages are refused.
- Phone access stays closed until you turn it on. Then it answers only this computer, the private network and Tailscale addresses. Every request and answer is encrypted with the key each phone got from its QR code (ChaCha20-Poly1305), and each request carries its time and a value used once, so it cannot be sent again. Someone else on the Wi-Fi can neither read it nor answer in your place. A phone can only answer decisions and permission asks, write to sessions and read the view.
- Phone notifications pass through the phone browser's push service (Apple, Google and others). They are encrypted with that browser's key (RFC 8291), so the service cannot read them, and they carry only the project name and the question's first line, or for a permission ask the tool name and the masked first line of the command.
- The work log is deleted after 7 days. Your account email is shown masked and is never sent anywhere.

## Development

```sh
pnpm test        # bridge, mod and scripts (node:test), and UI logic (vitest)
pnpm typecheck
pnpm build && pnpm start
claude plugin test mod
```

Tests run with your account environment variables removed and a temporary home folder (`scripts/test-env.ts`).

Check the UI against a bridge kept apart from your real data. macOS limits socket paths to about 104 bytes, so keep them short.

```sh
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_DB=/tmp/sb/ide.db node bridge/server.ts &
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_CAPTURE=/tmp/sb/shot.png pnpm exec electron .
```

With `CLAUDE_IDE_CAPTURE` set, the app saves the screen as a PNG without showing a window and exits. [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) explains how to add a theme. Redraw the app icon with `node scripts/icon.mjs`.

## License

[MIT](LICENSE)
