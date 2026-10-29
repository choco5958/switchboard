# Switchboard

**한국어** | [English](README.en.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Claude Code, Codex, Gemini 같은 코딩 에이전트 세션 여러 개를 한 화면에서 지휘하는 데스크톱 앱입니다. macOS, Windows, Linux에서 돕니다.

세션은 사람의 결정이 필요하면 질문을 결정 대기 큐에 올리고, 답을 기다리지 않고 다른 일을 이어 갑니다. 키 하나로 답하면 그 답이 해당 세션에 프롬프트로 들어갑니다. 세션끼리 일을 주고받고, 자리를 비운 동안에는 결정 질문과 권한 확인이 내 Telegram으로 옵니다.

![홈 화면: 프로젝트별 작업, 결정 대기, 작업 로그](docs/screenshot-home.png)

## 주요 기능

### 결정과 작업

- **결정 대기 큐**: 세션이 `ask_decision`으로 선택지, 추천, 추천 이유를 올립니다. `a`, `b` 같은 키로 고르고 `Enter`로 보냅니다. 보류하거나 메모를 붙여 답할 수도 있습니다. 같은 질문은 두 번 올라가지 않습니다.
- **작업과 진행 그래프**: 작업 단계(요구, 설계, 작업, 완료)와 노드(확인, 구현, 시험, 검토)가 화면에 그려지고, 노드마다 맡은 서브에이전트가 실행 중인지 끝났는지 보입니다.
- **나를 기다림**: 결정 대기가 있거나, 턴이 5분 넘게 멈췄거나, 사용량 한도에 걸렸거나, 세션이 끊긴 작업이 사이드바 맨 위에 모입니다. 멈춘 세션과 한도가 풀린 세션은 macOS 알림으로도 알립니다.
- **프로젝트별 보기**: 왼쪽 목록에서 폴더를 고르면 화면 전체가 그 프로젝트의 세션과 작업만 보여 줍니다.

### 세션끼리 일하기

- **묻고 답하기**: 세션이 `list_sessions`로 다른 세션을 찾고 `send_to_session`으로 요청을 보냅니다. 받은 세션이 따로 답하지 않고 턴을 끝내면 마지막 답변이 결과로 돌아갑니다.
- **여러 세션에 묻기**: 여러 세션에 보낸 질문은 답을 모아 한 턴에 넣습니다. 그사이 사람이 앱이나 터미널에서 말을 걸면 그때까지 온 답을 함께 넣고, 15분이 지나면 먼저 온 답부터 넘깁니다.
- **답이 오지 않을 때**: 받은 세션의 연결이 끊기거나 턴이 중단되면, 보낸 세션에 답이 오지 않는다는 알림이 갑니다. 보낸 세션은 기다리지 않고 일을 이어 갑니다.
- **맡긴 일 취소와 위임 한도**: 세션은 `cancel_request`로 자기가 맡긴 요청을 거둬들입니다. 전달 전이면 들어가지 않고, 받은 세션의 턴이 그 요청만 처리하고 있으면 턴을 멈춥니다. 한 요청에서 시작해 세션끼리 맡기는 요청은 모두 합쳐 8번까지입니다.
- **결정 넘기기**: 결정 질문을 다른 세션에게 넘겨 대신 답하게 할 수 있습니다.
- **사용량 한도**: 한도에 걸린 세션에 보낼 답과 메시지는 리셋될 때까지 모아 두었다가 전달합니다.

### 자리를 비운 동안

- **Telegram으로 답하기**: 앱이 꺼졌거나, 화면이 잠겼거나, 5분 넘게 입력이 없으면 결정 질문을 내 Telegram 봇으로 보냅니다. 버튼이나 답장으로 답합니다.
- **권한 확인 중계**: 같은 상황에서 Claude Code의 권한 확인도 앱과 Telegram으로 옵니다. Telegram에서 허용하려면 한 번 더 눌러야 합니다. 책상 앞에 있을 때는 지금처럼 터미널이 묻습니다.
- **예약 프롬프트**: 매일, 평일, 간격, 한 번 중에 골라 프로젝트의 세션에 프롬프트를 넣습니다. 연결된 세션이 없으면 앱이 `+ Claude` 터미널을 엽니다. 알릴 것이 없는 실행은 알림을 보내지 않습니다.

### 화면을 보며 고치기 (다이나믹 디버깅)

- 개발 서버를 등록해 띄우고 내장 브라우저로 엽니다.
- 화면 요소를 눌러 코멘트를 남기면 위치, CSS, 스크린샷, 그때 페이지의 콘솔 오류와 실패한 요청이 함께 세션에 갑니다.
- 세션은 `browser_*` 도구로 로컬 페이지를 직접 읽고, 누르고, 입력해 고친 결과를 확인합니다. 이 컴퓨터나 사설망의 주소만 다룹니다.
- 앱 터미널에서 CLI가 여는 로컬 주소는 내장 브라우저로 열립니다.

### 터미널과 셸

- **내장 터미널**: 아래 도크의 `+ Claude`는 mod가 연결된 Claude Code를, `+ 셸`은 일반 셸을 엽니다.
- **다른 코딩 CLI**: Codex, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Goose, Amp도 결정 대기와 작업 보고에 연결됩니다. 앱이 MCP 서버를 실행 옵션으로 붙이므로 각 CLI의 설정 파일은 건드리지 않습니다. Cursor CLI, Grok, Kimi, Crush는 터미널로만 열고, 그 밖의 CLI는 설정에서 명령을 등록합니다. 설치된 CLI만 도크에 나옵니다.
- **`switchboard` 명령**: 셸이나 스크립트에서 세션에 일을 맡기고 결과를 받습니다. 결과는 종료 코드로도 구분됩니다.
- **세션 쪽 패널**: Claude Code 안에서 `/switchboard`를 입력하면 이 세션의 작업 흐름과 결정 대기를 옆 창으로 봅니다.

### 화면

- 상단에 Claude의 5시간, 주간 사용량과 컨텍스트 사용률이 보입니다.
- 한국어, English, 日本語, 简体中文을 지원합니다. 처음에는 OS 언어를 따르고 설정에서 바꿉니다.
- 테마 13개: 기본 남색, 모험 일지, 인광 터미널, 도트 픽셀, 지하철 노선도, 회로 기판, 요즘 터미널, 파란 도스 창, Dracula, Nord, Solarized 어두움과 밝음, GitHub 밝음.
- Orca가 설치되어 있으면 노드마다 워크트리를 만들고, Linear 이슈를 작업으로 시작할 수 있습니다.

![결정 대기: 파란 도스 창 테마](docs/screenshot-decision.png)

![작업 화면: 단계와 진행 그래프](docs/screenshot-task.png)

## 구조

```
Claude Code 세션 ──(mod: ide-bridge)─────┐
Claude Code 세션 ──(mod: ide-bridge)─────┼── 브리지 (Unix 소켓 + SQLite) ── Switchboard 앱 (Electron)
Codex, Gemini 등 ──(MCP: mcp/server.ts)──┤
switchboard 명령 ────────────────────────┤
Telegram 봇 ──(long polling)─────────────┘
```

| 폴더 | 역할 |
| --- | --- |
| `bridge/` | 로컬 중계 서버. `~/.claude-ide/bridge.sock` 소켓과 `~/.claude-ide/ide.db` SQLite를 씁니다. 외부 네트워크에는 포트를 열지 않습니다. 예약 실행과 Telegram 연결도 여기서 돕니다. |
| `mod/` | Claude Code mod `ide-bridge`. 도구를 등록하고, 앱에서 온 답을 세션에 넣고, `/switchboard` 패널을 그립니다. |
| `mcp/` | 다른 코딩 CLI용 MCP 서버(stdio). mod와 같은 도구에 `check_answers`를 더해 엽니다. |
| `scripts/` | 설치 스크립트와 `switchboard` 명령. |
| `src/` | Electron 앱(React). |

## 준비물

- macOS, Windows, Linux. macOS(Apple Silicon)에서 확인했습니다. Windows와 Linux는 자동 테스트만 거쳤고 실제 기기에서는 아직 확인하지 않았습니다.
- Claude Code 2.1.309 이상 (mod 기능을 씁니다)
- 선택: Codex, Gemini CLI 같은 다른 코딩 CLI, Orca(워크트리, Linear), Telegram 계정, 터미널 한글 표시용 [D2Coding](https://github.com/naver/d2codingfont) 글꼴
- 소스에서 실행할 때만: Node.js 24 이상, pnpm

## 설치

### 설치 파일

[Releases](https://github.com/choco5958/switchboard/releases/latest)에서 운영체제에 맞는 파일을 받습니다. 앱에 Node가 들어 있어서 따로 설치할 것이 없습니다.

| 운영체제 | 파일 |
| --- | --- |
| macOS | Apple Silicon은 `Switchboard-<버전>-mac-arm64.dmg`, Intel은 `-mac-x64.dmg` |
| Windows | `Switchboard-<버전>-win-x64.exe` (ARM 기기는 `-win-arm64.exe`) |
| Linux | `.AppImage`(실행 권한을 주고 바로 실행) 또는 `.deb` |

아직 코드 서명을 하지 않아서 처음 열 때 경고가 뜹니다.

- macOS: 앱을 응용 프로그램 폴더로 옮긴 뒤 우클릭 > 열기를 누르고, 다시 뜨는 창에서 한 번 더 열기를 누릅니다.
- Windows: "Windows의 PC 보호" 창에서 추가 정보 > 실행을 누릅니다.

앱은 켤 때마다 `~/.claude-ide`에 브리지 시작 파일과 `switchboard` 명령을 이 앱 위치에 맞춰 다시 씁니다. `switchboard` 명령은 macOS와 Linux에서 `~/.local/bin`에, Windows에서 `%USERPROFILE%\.claude-ide\bin`에 생기므로 그 폴더를 PATH에 넣습니다.

새 버전은 앱이 알아서 확인합니다. Windows와 Linux(AppImage)는 새 버전을 내려받아 두었다가 앱을 닫을 때 설치합니다. macOS는 서명이 없으면 자동 설치가 되지 않아서, 알림을 누르면 다운로드 페이지가 열립니다.

### 소스에서 실행

```sh
git clone https://github.com/choco5958/switchboard.git
cd switchboard
pnpm install
pnpm run setup  # ~/.claude-ide/start-bridge.json과 ~/.local/bin/switchboard를 만듭니다
pnpm dev        # 앱 실행
```

레포 폴더를 옮기면 `pnpm run setup`을 다시 실행합니다. 설치 파일은 `pnpm dist`로 만듭니다.

### 다른 터미널의 Claude Code 연결

앱의 `+ Claude` 터미널은 mod를 자동으로 불러옵니다. 다른 터미널에서 연 Claude Code 세션도 연결하려면 Claude Code 입력창에서 mod를 설치합니다.

```
/plugin install ide-bridge --marketplace choco5958/switchboard
```

`Add marketplace?`에 `y`를 누르고, 범위는 첫 번째인 user를 고릅니다. 셸에서는 `claude plugin install ide-bridge --marketplace choco5958/switchboard`로 설치합니다.

설치한 뒤 새로 연 세션부터 브리지에 연결됩니다. 브리지가 꺼져 있으면 mod나 앱이 먼저 켭니다. mod는 앱이나 `pnpm run setup`이 만든 `~/.claude-ide/start-bridge.json`으로 브리지를 켜므로, 앱을 한 번 켜 두거나 setup을 실행해 두어야 합니다.

## 쓰는 법

1. 앱을 켜고 아래 도크에서 `+ Claude`를 누릅니다. 처음이면 왼쪽 위 `+ 폴더`로 작업할 프로젝트 폴더를 고릅니다.
2. 평소처럼 Claude Code에게 일을 맡깁니다. 도구 설명에 언제 쓰는지 적혀 있어서, 세션이 알아서 작업을 올리고 결정이 필요하면 질문을 올립니다.
3. 왼쪽 물음표 아이콘에 숫자가 뜨면 결정 대기 질문이 온 것입니다. 질문을 열고 키로 답합니다.

### 키

| 키 | 동작 |
| --- | --- |
| `a`, `b`, `1`, `2` | 선택지 고르기 |
| `Enter` | 보내기 |
| `H` | 보류 |
| `M` | 메모 입력 (`Cmd+Enter` 보내기, `Esc` 나가기) |
| `Cmd+K` | 찾기 (작업 열기, 진행 보고 받기 같은 할 일) |

### Telegram 연결

1. Telegram에서 `@BotFather`에게 `/newbot`을 보내고 봇 이름과 아이디를 정합니다.
2. Switchboard의 설정 > Telegram으로 답하기에 BotFather가 준 토큰(`123456:ABC...` 꼴)을 붙여 넣고 봇 연결을 누릅니다.
3. 연결 코드 받기를 누르고, 10분 안에 휴대폰에서 링크를 열어 시작을 누릅니다. 그 대화방만 연결되고, 다른 사람이 보낸 답은 받지 않습니다.

브리지가 Telegram 서버에 새 메시지를 직접 물어보는 방식이라 열어 둘 포트가 없습니다.

### 예약 프롬프트

설정 > 예약 프롬프트에서 이름, 프로젝트, 프롬프트, 일정을 정합니다. 간격은 5분 이상입니다. 이전 실행이 끝나지 않았으면 이번 실행은 건너뜁니다. 앱이나 브리지가 꺼져 있던 동안 놓친 실행은 켜질 때 한 번 실행할지 고를 수 있습니다.

### 셸 명령

| 명령 | 하는 일 |
| --- | --- |
| `switchboard sessions` | 세션 목록 (● 연결됨) |
| `switchboard send <세션 또는 프로젝트> <할 일 또는 -> [--wait] [--timeout 30m] [--info] [--json]` | 세션에 일을 맡기고 `m7` 같은 번호를 출력합니다. `--wait`를 붙이면 결과까지 기다려 출력하고, `--info`는 답을 기대하지 않는 알림으로 보냅니다. `-`는 표준 입력을 읽습니다. |
| `switchboard status m7` | 맡긴 일의 상태와 결과 |
| `switchboard decisions`, `switchboard answer Q12 a [메모]` | 결정 대기를 보고 답합니다. |
| `switchboard waits`, `switchboard fire w3 [내용]` | 세션이 연 대기를 보고 깨웁니다. |

종료 코드: 0 완료, 1 실패, 2 명령줄 오류, 3 세션이 결정을 기다림, 4 시간 초과(세션은 계속 일함), 5 브리지가 꺼졌거나 세션이 없음.

```sh
# 테스트가 끝나면 그 결과를 기다리던 세션을 깨웁니다
pnpm test; switchboard fire w3 "테스트 끝남: 종료 코드 $?"
```

## 세션이 쓰는 도구

| 도구 | 하는 일 |
| --- | --- |
| `ask_decision` | 결정 대기 큐에 질문을 올립니다. 기다리지 않고 바로 돌아옵니다. |
| `set_task` | 작업을 만들거나 단계, 지금 하는 일, 시험 결과를 갱신합니다. |
| `plan_nodes`, `update_node` | 작업을 노드로 나눠 진행 그래프에 올리고 상태(대기, 지금, 끝, 실패)를 바꿉니다. |
| `node_worktree` | 노드에 Orca 워크트리를 만듭니다. Orca가 있어야 합니다. |
| `open_in_ide` | 다이나믹 디버깅 탭에서 페이지나 개발 서버를 엽니다. |
| `list_sessions`, `send_to_session` | 다른 세션을 보고 요청이나 정보를 보냅니다. 답은 다음 턴에 들어옵니다. |
| `cancel_request` | 자기가 맡긴 요청을 취소합니다. 받은 세션이 그 요청만 처리하고 있으면 턴을 멈춥니다. |
| `await_event`, `close_wait` | 빌드나 배포처럼 바깥 일을 기다리는 대기를 열고 닫습니다. |
| `routine_no_update`, `routine_report_failure` | 예약 실행에서 알릴 것이 없거나 실패했음을 남깁니다. |
| `browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate`, `browser_console`, `browser_screenshot` | 내장 브라우저의 로컬 페이지를 읽고 다룹니다. 오래된 ref로 누르려 하면 거절합니다. |
| `check_answers` | 다른 코딩 CLI용. 앱 밖에서 도는 세션이 아직 받지 않은 답을 가져갑니다. |

## 데이터와 보안

- 모든 데이터는 이 컴퓨터의 `~/.claude-ide/` 아래에만 저장됩니다. 폴더는 본인만 읽을 수 있고(0700), 소켓과 DB도 본인 전용입니다(0600).
- Telegram을 연결하면 결정 질문과 권한 확인 내용이 Telegram 서버를 거칩니다. 토큰처럼 보이는 값은 보내기 전에 가립니다. 봇 토큰은 화면 상태에 싣지 않고 DB에만 둡니다.
- 화면 코멘트에 붙는 콘솔 기록과 요청 기록도 토큰처럼 보이는 값을 수집할 때 가립니다.
- 세션의 브라우저 도구는 이 컴퓨터와 사설망 주소만 엽니다.
- Windows에서는 브리지가 127.0.0.1에만 포트를 열고, 켤 때마다 새로 만든 토큰이 있는 요청에만 답합니다. 웹 페이지에서 온 요청은 거절합니다.
- 작업 로그는 7일이 지나면 지웁니다. 계정 이메일은 화면에 가려서 보여 주고 어디에도 보내지 않습니다.

## 개발

```sh
pnpm test        # 브리지, mod, 스크립트(node:test)와 화면 로직(vitest)
pnpm typecheck
pnpm build && pnpm start
claude plugin test mod
```

테스트는 실제 계정 환경변수를 지우고 임시 홈 폴더에서 돕니다(`scripts/test-env.ts`).

화면 확인은 실제 데이터와 분리된 브리지로 합니다. macOS는 소켓 경로를 약 104바이트로 제한하므로 짧게 둡니다.

```sh
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_DB=/tmp/sb/ide.db node bridge/server.ts &
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_CAPTURE=/tmp/sb/shot.png pnpm exec electron .
```

`CLAUDE_IDE_CAPTURE`를 주면 창을 띄우지 않고 화면을 PNG로 저장한 뒤 끝납니다. 테마를 더하는 법은 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)에 있습니다. 앱 아이콘은 `node scripts/icon.mjs`로 다시 그립니다.

## 라이선스

[MIT](LICENSE)
