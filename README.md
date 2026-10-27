# Switchboard

Claude Code, Codex, Gemini 같은 코딩 에이전트 세션 여러 개를 한 화면에서 지휘하는 데스크톱 앱입니다. 세션이 사람의 결정이 필요한 지점에서 질문을 올리면 결정 대기 큐에 쌓이고, 키 하나로 답하면 그 답이 해당 세션에 프롬프트로 들어갑니다. 세션은 답을 기다리며 멈추지 않고 다른 일을 이어 갑니다. 작업 단계, 진행 그래프, 서브에이전트, 작업 로그도 같은 화면에서 봅니다.

![홈 화면: 프로젝트별 작업, 결정 대기, 작업 로그](docs/screenshot-home.png)

## 무엇을 하나요

- **결정 대기 큐**: 세션이 `ask_decision` 도구로 질문을 올립니다. 선택지, 추천, 추천 이유가 함께 오고, `a`, `b` 같은 키로 고른 뒤 `Enter`로 보냅니다. 보류하거나 메모를 붙여 답할 수도 있습니다.
- **작업과 진행 그래프**: 세션이 `set_task`, `plan_nodes`, `update_node`로 작업 단계(요구, 설계, 작업, 완료)와 노드(확인, 구현, 시험, 검토)를 올립니다. 노드마다 맡은 서브에이전트가 실행 중인지 끝났는지 보입니다.
- **프로젝트별 보기**: 폴더 단위로 세션과 작업을 나눠 봅니다. 왼쪽 목록에서 프로젝트를 고르면 화면 전체가 그 프로젝트만 보여 줍니다.
- **내장 터미널**: 아래 도크에서 `+ Claude`를 누르면 mod가 연결된 Claude Code가 바로 뜹니다. `+ 셸`은 일반 셸입니다.
- **다이나믹 디버깅**: 개발 서버를 등록해 띄우고 내장 브라우저로 엽니다. 화면 요소를 눌러 코멘트를 남기면 위치, CSS, 스크린샷과 함께 세션에 보냅니다. 세션에게 "검수 앱 8951 열어줘"라고 하면 세션이 `open_in_ide`로 그 화면을 엽니다.
- **세션 쪽 패널**: Claude Code 안에서 `/switchboard`를 입력하면 이 세션의 작업 흐름과 결정 대기를 옆 창으로 봅니다. `/switchboard 보고`, `/switchboard 갱신`으로 진행 보고나 IDE 정보 갱신을 부탁합니다.
- **다른 코딩 CLI**: Codex, Gemini CLI, Qwen Code, GitHub Copilot CLI, OpenCode, Goose, Amp도 결정 대기와 작업 보고에 연결됩니다. 앱이 MCP 서버를 실행 옵션으로 붙이므로 각 CLI의 설정 파일은 건드리지 않습니다. 앱 터미널에서 돌면 답을 그 터미널에 입력해 넣고, 앱 밖에서 돌면 세션이 `check_answers`로 답을 가져갑니다. Cursor CLI, Grok, Kimi, Crush는 터미널로만 열고, 그 밖의 CLI는 설정에서 명령을 직접 등록합니다. 설치된 CLI만 도크에 버튼으로 나옵니다.
- **다국어**: 한국어, English, 日本語, 简体中文. 처음에는 OS 언어를 따르고 설정에서 바로 바꿉니다.
- **사용량 표시**: 상단에 Claude의 5시간, 주간 사용량과 컨텍스트 사용률이 보입니다.
- **테마 13개**: 기본 남색, 모험 일지, 인광 터미널, 도트 픽셀, 지하철 노선도, 회로 기판, 요즘 터미널, 파란 도스 창, Dracula, Nord, Solarized 어두움과 밝음, GitHub 밝음.
- **Orca 연동(선택)**: Orca가 설치되어 있으면 노드마다 워크트리를 만들고, Linear 이슈를 작업으로 시작할 수 있습니다.

![결정 대기: 파란 도스 창 테마](docs/screenshot-decision.png)

![작업 화면: 단계와 진행 그래프](docs/screenshot-task.png)

## 구조

```
Claude Code 세션 ──(mod: ide-bridge)─────┐
Claude Code 세션 ──(mod: ide-bridge)─────┼── 브리지 (Unix 소켓 + SQLite) ── Switchboard 앱 (Electron)
Codex, Gemini 등 ──(MCP: mcp/server.ts)──┘
```

| 폴더 | 역할 |
| --- | --- |
| `bridge/` | 로컬 중계 서버. `~/.claude-ide/bridge.sock` 소켓과 `~/.claude-ide/ide.db` SQLite를 씁니다. 외부 네트워크에는 열지 않습니다. |
| `mod/` | Claude Code mod `ide-bridge`. 도구를 등록하고, 앱에서 온 답을 세션에 넣고, `/switchboard` 패널을 그립니다. |
| `mcp/` | 다른 코딩 CLI용 MCP 서버(stdio). mod와 같은 도구에 `check_answers`를 더해 엽니다. |
| `src/` | Electron 앱(React). |

## 준비물

- macOS (Apple Silicon에서 확인했습니다. Linux는 확인하지 않았고, Windows는 지원하지 않습니다.)
- Node.js 24 이상 (브리지가 `node:sqlite`를 쓰고 `.ts` 파일을 바로 실행합니다)
- pnpm
- Claude Code 2.1.309 이상 (mod 기능을 씁니다)
- 선택: Codex, Gemini CLI 같은 다른 코딩 CLI, Orca (워크트리, Linear), 터미널 한글 표시용 [D2Coding](https://github.com/naver/d2codingfont) 글꼴

## 설치

```sh
git clone https://github.com/choco5958/switchboard.git
cd switchboard
pnpm install
pnpm run setup  # ~/.claude-ide/start-bridge.sh를 만듭니다. 레포 폴더를 옮기면 다시 실행합니다.
pnpm dev        # 앱 실행
```

앱의 `+ Claude` 터미널은 mod를 자동으로 불러옵니다. 다른 터미널에서 연 Claude Code 세션도 연결하려면 mod를 설치합니다. Claude Code 입력창에서:

```
/plugin install ide-bridge --marketplace choco5958/switchboard
```

`Add marketplace?`에 `y`를 누르고, 범위는 첫 번째인 user를 고릅니다. 셸에서 설치하려면:

```sh
claude plugin install ide-bridge --marketplace choco5958/switchboard
```

설치한 뒤 새로 연 세션부터 브리지에 연결됩니다. 브리지가 꺼져 있으면 mod나 앱이 먼저 켭니다. mod는 `pnpm run setup`이 만든 `start-bridge.sh`로 브리지를 켜므로, mod만 설치하고 레포를 받지 않으면 동작하지 않습니다.

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

### 세션이 쓰는 도구

| 도구 | 하는 일 |
| --- | --- |
| `ask_decision` | 결정 대기 큐에 질문을 올립니다. 기다리지 않고 바로 돌아옵니다. |
| `set_task` | 작업을 만들거나 단계, 지금 하는 일, 시험 결과를 갱신합니다. |
| `plan_nodes` | 작업을 노드로 나눠 진행 그래프에 올립니다. |
| `update_node` | 노드 상태를 바꿉니다 (대기, 지금, 끝, 실패). |
| `node_worktree` | 노드에 Orca 워크트리를 만듭니다. Orca가 있어야 합니다. |
| `open_in_ide` | 다이나믹 디버깅 탭에서 페이지나 개발 서버를 엽니다. |
| `check_answers` | 다른 코딩 CLI용. 앱 밖에서 도는 세션이 아직 받지 않은 답을 가져갑니다. |

## 데이터

모든 데이터는 이 컴퓨터의 `~/.claude-ide/` 아래에만 저장됩니다. 폴더는 본인만 읽을 수 있고(0700), 소켓과 DB도 본인 전용입니다(0600). 작업 로그는 7일이 지나면 지웁니다. 계정 이메일은 화면에 가려서 보여 주고 어디에도 보내지 않습니다.

## 개발

```sh
pnpm test        # 브리지와 mod(node:test), 화면 로직(vitest)
pnpm typecheck
pnpm build && pnpm start
claude plugin test mod
```

화면 확인은 실제 데이터와 분리된 브리지로 합니다. macOS는 소켓 경로를 약 104바이트로 제한하므로 짧게 둡니다.

```sh
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_DB=/tmp/sb/ide.db node bridge/server.ts &
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_CAPTURE=/tmp/sb/shot.png pnpm exec electron .
```

`CLAUDE_IDE_CAPTURE`를 주면 창을 띄우지 않고 화면을 PNG로 저장한 뒤 끝납니다. 테마를 더하는 법은 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)에 있습니다. 앱 아이콘은 `node scripts/icon.mjs`로 다시 그립니다.

## English

Switchboard is a macOS desktop app for running several coding-agent sessions at once: Claude Code, plus Codex, Gemini CLI and other CLIs through an MCP server. Sessions post questions to a decision queue instead of stopping; you answer with a key press and the answer goes back to the session as a prompt. It also shows task stages, a progress graph per task, subagents, a work log, built-in terminals, and a dev-server browser where you can pin comments on page elements and send them to a session. The UI is available in Korean, English, Japanese and Simplified Chinese, with 13 themes.

Install: clone, `pnpm install`, `pnpm run setup`, `pnpm dev`. To connect sessions started outside the app, run `/plugin install ide-bridge --marketplace choco5958/switchboard` in Claude Code.

## 라이선스

[MIT](LICENSE)
