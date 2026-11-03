# Tauri 이전 계획

Switchboard를 Electron에서 Tauri 2(OS 기본 웹뷰)로 옮긴다. 2026-11-03에 정했다.

## 왜

- 설치 크기: Electron판 앱은 273MB(dmg 120MB)이고, Tauri 시험판 앱은 7.3MB였다.
- 메모리: 같은 화면과 터미널 출력으로 재 보니 Electron 약 310MB, Tauri 약 270MB였다(활성 상태 보기 기준, 브리지와 셸 제외). 메모리만 보면 이득이 작다.
- 시험판: `tauri-poc` 브랜치(로컬 커밋 0139d19)에 있다.

## 정한 것

- **Node 동봉 + 얇은 Rust.** Node 실행 파일을 앱에 함께 싣고, 지금 TypeScript 코드(브리지, 터미널 호스트, MCP 서버, `switchboard` 명령, 메인 프로세스의 앱 논리)는 그대로 쓴다. Rust는 창, 웹뷰, 알림, 대화상자, 배지, 전원 이벤트, 키체인, 업데이트처럼 OS에 닿는 일만 맡는다.
- **나란히 키운다.** 이전이 끝날 때까지 Electron판이 계속 릴리스된다. Tauri판은 `src-tauri/`와 `src/host/`에서 자라고, 넘어가는 릴리스에서 Electron판을 걷어 낸다.
- **같은 앱 논리를 두 셸이 쓴다.** 메인 프로세스의 앱 논리는 `Platform`(src/main/platform.ts) 하나에만 기댄다. Electron판은 Electron으로, Tauri판은 Rust와 주고받는 표준 입출력으로 이것을 구현한다.

## 구조 (Tauri판)

```
웹뷰(지금 화면 그대로) ⇄ Rust 셸 ⇄ Node 호스트(src/host, 앱 논리) ⇄ 브리지, 터미널 호스트
```

- 화면은 `window.ide`를 그대로 쓴다. Electron판의 preload 대신, 같은 채널 이름으로 Rust에 보내는 얇은 층이 들어간다.
- Rust 셸은 화면의 호출을 Node 호스트에 넘기고(줄 단위 JSON, 표준 입출력), Node 호스트가 보낸 이벤트를 화면에 보낸다. Node 호스트가 OS 일을 부탁하면(알림, 대화상자 등) Rust가 처리한다.

## 단계

1. [x] **Platform 분리:** `src/main`의 앱 논리가 Electron 대신 `Platform`에 기대게 한다. Electron판 동작은 그대로 둔다.
2. [x] **화면 API 표:** preload와 Tauri용 층이 같은 채널 표를 쓰게 한다.
3. [x] **Node 호스트와 Rust 셸:** 저장소에서 Tauri판을 띄워 모든 화면(내장 브라우저 제외)이 동작하게 한다.
4. [x] **OS 기능:** 알림(누르면 창을 앞으로), 확인 대화상자, 폴더 고르기, Dock 배지, 자리 비움, 잠자기 막기, 한 번만 실행, 키체인, macOS에서 창을 닫아도 앱 유지. 잠금, 해제, 깨어남 이벤트는 아직 없다(30초마다 자리 비움을 다시 보고해서 늦게나마 맞춰진다).
5. [ ] **Node 동봉과 패키지:** 플랫폼별 Node 실행 파일을 싣고, 실행 스크립트(start-bridge, switchboard)가 그것을 쓰게 한다.
6. [ ] **내장 브라우저:** `<webview>` 대신 Tauri 하위 웹뷰. 화면 찍기, 콘솔 읽기, 클릭과 입력. macOS와 Linux에서는 실패한 요청 기록이 빠진다.
7. [ ] **업데이트와 릴리스:** Tauri 업데이터, 릴리스 워크플로, Electron판에서 Tauri판으로 넘어가는 중간 버전.
8. [ ] **Windows와 Linux 확인, 전환.**

## 저장소에서 띄우기

```sh
pnpm build                      # 화면, Node 쪽, Node 호스트(out/host/main.mjs)
cd src-tauri && cargo build --release
./target/release/switchboard     # 시스템의 node로 호스트를 띄운다
```

이 실행은 진짜 `~/.claude-ide`의 브리지를 쓰고, 자기가 띄우지 않은 브리지를 교체한다. 시험할 때는 `HOME`, `CLAUDE_IDE_SOCKET`, `CLAUDE_IDE_DB`를 임시 폴더로 돌린다. `CLAUDE_IDE_CAPTURE_JS`를 주면 창을 띄우지 않고 페이지가 뜬 뒤 그 스크립트를 돌리며, 스크립트는 `capture_log` 명령으로 결과를 남긴다.

## 지금까지 알게 된 것

- **숨은 창의 페이지:** WebKit은 보이지 않는 창의 페이지를 멈춘다. 답 보내기의 5초 되돌리기처럼 페이지가 뒤에서 하는 일이 있어서, 주 창은 `backgroundThrottling: disabled`로 둔다. 그래도 한 번도 보인 적 없는 창은 그리지 않아서, 숨은 시험에서는 터미널 글자가 화면에 그려지는지 확인할 수 없다.
- **undefined 인자:** Electron IPC는 undefined를 그대로 넘기고 처리기는 그것을 null과 구분한다. JSON에는 undefined가 없어서 Tauri 쪽은 표시를 붙여 보내고 호스트가 되살린다(src/shared/ideCalls.ts).
- **시험 실행과 OS 기능:** `CLAUDE_IDE_CAPTURE_JS`가 있으면 키체인, 대화상자, 알림을 건드리지 않는다. 키는 실행마다 새로 만들고(그래서 터미널 호스트 대신 Node 호스트 안에서 터미널이 돈다), 확인 대화상자는 취소로, 폴더 고르기는 고르지 않음으로 답하고, 알림은 로그에만 남긴다.
- **사람이 봐야 확인되는 것:** 키체인(처음 저장, 다시 읽기, 거절), 확인 대화상자, 폴더 고르기, 알림 누르기, 한 번만 실행, 창을 닫았다가 Dock으로 다시 열기. 잠자기 막기와 자리 비움은 Rust 단위 테스트로 확인했다.

## 주의

- 시험용 실행은 항상 캡처 모드나 화면 밖에서 한다. 저장소에서 띄운 Electron판과 설치된 앱은 같은 데이터 폴더를 쓴다.
- 이전 중에도 Electron판 테스트와 릴리스가 깨지면 안 된다.
