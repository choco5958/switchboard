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
4. [x] **OS 기능:** 알림(누르면 창을 앞으로), 확인 대화상자, 폴더 고르기, Dock 배지, 자리 비움, 잠자기 막기, 한 번만 실행, 키체인, macOS에서 창을 닫아도 앱 유지. 잠금, 해제, 깨어남은 셸이 2초마다 살펴 호스트에 알린다(src-tauri/src/os.rs watch_power). 잠금은 macOS의 로그인 세션 정보(CGSSessionScreenIsLocked)로 보고, 잠겨 있으면 자리 비움 상태가 곧바로 "locked"가 된다. 깨어남은 2초 간격이 15초 넘게 벌어진 것으로 본다. Windows와 Linux는 잠금을 읽지 못해 지금처럼 5분 동안 입력이 없을 때 자리 비움이 된다.
5. [x] **Node 동봉과 패키지:** nodejs.org의 공식 Node(SHA-256 확인)를 `switchboard-node`로 싣고, Resources/node에 Electron판과 같은 Node 쪽 파일과 Node 호스트, node-pty와 xterm을 둔다. 실행 스크립트(start-bridge, switchboard)는 앱 안의 Node를 쓴다. macOS arm64 앱은 128MB, zip은 43.5MB(Electron판 273MB, dmg 120MB).
6. [x] **내장 브라우저 (macOS):** 브라우저 화면은 PageSurface(src/renderer/src/pageSurface.ts)만 다루고, Tauri판은 주 창의 하위 웹뷰로 이것을 구현한다(src-tauri/src/browser.rs, src/renderer/src/tauriSurface.ts). 스크립트는 WebKit의 앱 전용 세계(switchboard)에서 돌고 값을 돌려주며, 화면 찍기는 WebKit 스냅숏을 쓴다. 페이지 안에 넣은 스크립트(browser_page.js)가 콘솔, 오류, fetch와 XHR의 실패, 제목, 페이지 안 이동을 모으고, 셸이 0.4초마다 가져간다. Windows와 Linux는 8단계에서 채운다.
   - Electron판과 다른 점: 누르기와 입력은 진짜 입력이 아니라 DOM 이벤트다(isTrusted가 false). 연결 거부와 주소 못 찾음만 오류 화면으로 알린다(불러오기 전에 Rust가 연결해 본다). 이미지나 스크립트 같은 하위 자원의 실패는 오류 이벤트로만 남는다. 하위 웹뷰는 앱 화면 위에 그려지므로, 브라우저 자리 위로 뜨는 메뉴나 알림은 그 아래에 가린다.
   - 세션처럼 로컬 시험 페이지를 다뤄(POST /browser/act) 주소 열기, 읽기, 누르기, 입력, 화면 찍기, 콘솔과 실패한 요청을 두 앱에서 같게 확인했다. 화면 코멘트(⌥M로 요소 고르기)는 사람이 눌러 봐야 확인된다.
7. [x] **업데이트와 릴리스 (macOS):** 새 업데이터를 만들지 않고 지금 방식을 이어 쓴다. 릴리스의 latest-mac.yml에 프로젝트 키로 서명하고, 앱은 서명이 맞는 버전의 zip만 받아 종료할 때 번들을 교체한다. 그래서 Electron판도 Tauri판 zip을 다른 업데이트처럼 설치한다.
   - 두 셸이 같은 코드를 쓴다(src/main/updateFlow.ts). Electron판은 electron-updater로 새 버전을 찾고, Tauri판의 Node 호스트는 최신 릴리스의 latest-mac.yml을 직접 읽는다(updateSignature.ts latestSigned). 교체는 둘 다 macUpdate.ts의 스크립트가 하며, Tauri판은 Rust 셸의 pid와 실행 파일 위치를 호스트에 넘긴다.
   - 데이터 폴더: Tauri판도 Electron판의 userData(`~/Library/Application Support/claude-ide`)를 쓴다. 설정, 업데이트 폴더, Electron판이 남긴 키가 거기 있다.
   - 앱 키 이어받기: Tauri판의 키체인에 키가 없으면 Electron판의 app-key.bin을 연다(safeStorage 형식: "v10", 키체인 항목 "claude-ide Safe Storage"의 암호에서 PBKDF2로 만든 AES-128-CBC 키). 실제 Electron 45가 봉인한 값으로 Rust 테스트를 둔다. 키가 같으면 Electron판이 띄워 둔 브리지와 터미널 호스트를 그대로 쓰므로 세션과 터미널이 이어진다. 처음 한 번 키체인이 허락을 묻는다. 거절하면 새 키로 브리지를 다시 띄우고, 이전 터미널 호스트의 터미널은 보이지 않는다(계속 돌기는 한다).
   - macOS 최소 버전: Node 24가 macOS 13.5 이상에서만 돌아서 번들에 13.5를 적는다. 릴리스의 latest-mac.yml에 `minimumSystemVersion: 22.6.0`(Darwin 버전)을 적어, 설치된 Electron판(electron-updater 6.8)이 그보다 낮은 macOS에서는 넘어가지 않게 한다. 교체 코드도 번들의 최소 버전을 확인한다.
   - 서명: Electron판처럼 ad hoc으로 서명하고 hardened runtime은 끈다(tauri.conf.json). 켜면 앱 안의 Node가 ad hoc 서명된 node-pty를 불러오지 못한다. 교체 전에 앱이 하는 `codesign --verify --deep --strict`를 두 칩의 번들이 통과한다.
   - 릴리스 파일: `.github/workflows/tauri-mac.yml`이 두 칩의 앱을 만들고 scripts/pack-tauri-mac.ts가 zip, dmg(hdiutil로 만든다), latest-mac.yml을 Electron판과 같은 이름으로 만든다. 서명은 지금처럼 release 잡이 한다.
   - macOS를 넘기는 릴리스에서는 release.yml의 build 행렬에서 mac을 빼고 tauri-mac.yml을 `artifact: dist-mac`으로 부르는 잡을 넣는다. release 잡은 그 잡도 기다린다.
8. [x] **Windows와 Linux 확인, 전환.** 만들기, Electron판에서 넘어오기, 숨긴 확인이 세 OS에서 통과했다(tauri-check.yml 41786436608). 0.3.18 다음 릴리스부터 세 OS 모두 Tauri판을 낸다.
   - Rust 셸: Windows에서 콘솔 창을 띄우지 않고(앱과 Node 호스트 모두), 파일과 링크는 셸을 거치지 않고 연다(open 크레이트, Windows는 ShellExecute). Dock 배지는 macOS만 쓴다(Electron판도 다른 OS에서는 배지가 없다).
   - 내장 브라우저: Linux는 WebKitGTK의 이름 붙은 세계에서 스크립트를 돌리고(call_async_javascript_function, WebKitGTK 2.40 이상) get_snapshot으로 화면을 찍는다. Windows는 WebView2의 DevTools 채널을 쓴다(Page.createIsolatedWorld로 앱 전용 세계, Runtime.evaluate, Page.captureScreenshot). macOS도 앱 전용 세계(WKContentWorld)를 앱이 붙잡고 있어야 그 안의 값이 남는다는 것을 이번에 알았다. 붙잡지 않으면 호출마다 새 세계가 생겨 화면 코멘트의 상태가 사라질 수 있었다.
   - Node 실행 파일: Windows와 Linux의 Tauri판은 시작할 때 switchboard-node를 runtime 복사본 옆(`~/.claude-ide/runtime/<빌드>/bin`)에 복사해 브리지, 터미널 호스트, 실행 스크립트가 그것을 쓴다(src/main/appRoot.ts nodeExecutable). Windows는 실행 중인 파일을 잠가서 설치 폴더의 Node를 쓰면 업데이트가 덮어쓰지 못하고, AppImage는 앱이 끝나면 마운트가 사라진다. Electron판처럼 `$APPIMAGE`를 실행하면 Tauri판에서는 Node 대신 앱이 하나 더 뜨므로 이것도 함께 고쳤다.
   - 앱 키 이어받기: Linux의 Electron판 키(safeStorage "v11", 비밀 서비스의 application "claude-ide" 항목, PBKDF2 1회)도 연다. Windows는 터미널 호스트가 없어 이어받을 것이 없다.
   - 패키지: Windows는 NSIS 설치 파일(사용자별 설치), Linux는 AppImage와 deb. scripts/pack-tauri.ts가 Electron판과 같은 이름과 latest.yml, latest-linux.yml, latest-linux-arm64.yml을 만든다. Linux는 Ubuntu 22.04에서 만든다(더 새 배포판에서도 돌도록).
   - Electron판에서 넘어오기(Windows): 설치된 Electron판은 새 설치 파일을 `--updated /S`로 실행한다. Tauri판 설치 파일은 먼저 Electron판을 그 제거 프로그램으로 지우고(바로가기, 설치된 앱 목록 항목, 파일. 데이터 폴더는 남는다), `--force-run`이 있으면 설치 뒤 앱을 띄운다(src-tauri/windows/hooks.nsh). 모든 사용자용으로 설치한 Electron판(HKLM)은 관리자 권한이 필요해 그대로 둔다. latest.yml의 첫 설치 파일이 x64라서 ARM64 PC의 Electron판도 x64 Tauri판을 받는다. 셸이 기계의 실제 아키텍처(IsWow64Process2)를 호스트에 알려, 그다음 업데이트에서 ARM64판으로 바뀐다.
   - Electron판에서 넘어오기(Linux): AppImage는 Electron판의 업데이터가 새 파일을 제자리에 두고 `APPIMAGE_EXIT_AFTER_INSTALL`로 한 번 실행해 끝나기를 기다린다. Tauri판은 이때 바로 끝나고, 다음에 열 때 뜬다. deb는 패키지 이름이 바뀌어서(claude-ide에서 switchboard로) Conflicts와 Replaces를 적어, apt로 설치하면 Electron판 패키지가 빠진다.
   - Tauri판의 업데이트: Windows는 설치 파일을 받아 두었다가, 앱이 끝나면 브리지가 쓰는 Node 복사본이 `/S`로 실행하고 앱을 다시 연다. NSIS의 `/R`은 사용자 권한으로 앱을 띄우는 방식이 셸 없이 돌 때 실패해서 쓰지 않는다. PowerShell도 쓰지 않는다. detached로 띄우면 콘솔이 없어서 Windows PowerShell이 한 줄도 돌리지 않고 종료 코드 0으로 끝나고, detached 없이 띄우면 호스트가 끝날 때 함께 끝난다. 설치 과정은 데이터 폴더의 update.log에 남는다. AppImage는 받은 파일이 앱이 끝날 때 `$APPIMAGE` 자리에 들어간다. deb는 지금처럼 다운로드 페이지를 알린다(src/main/installUpdate.ts).
   - 확인: `.github/workflows/tauri-check.yml`이 Windows(x64, arm64)와 Linux(x64, arm64)에서 만들고, Windows에서는 Electron판 0.3.17을 설치한 뒤 Tauri판으로 넘어가는지 보고, 설치된 앱을 scripts/tauri-smoke.ts로 숨겨서 돌린다(브리지, 세션 목록, 질문, 터미널, 내장 브라우저). 이 스크립트는 macOS에서도 같게 돈다.
   - 크기: Windows x64 설치 파일 약 32MB. Linux x64는 AppImage 126MB, deb 52.7MB.
   - 스스로 하는 업데이트 확인: scripts/tauri-update-check.ts가 버전을 0.0.1로 낮춘 앱을 띄우고, 같은 컴퓨터의 HTTPS 서버가 시험 키로 서명한 릴리스를 내준다(`CLAUDE_IDE_UPDATE_TEST`, 캡처 모드에서만 받는다). 앱이 받고, 끝나고, 새 앱이 다시 뜨는지 본다. macOS(CI에서만 돈다. 교체 뒤 `open`이 진짜 HOME으로 앱을 연다)와 Linux x64, arm64의 AppImage는 통과했다.
   - Linux의 Electron판 키 이어받기: 가상 화면과 gnome-keyring에서 실제 Electron판(x64 0.3.12, arm64 0.3.17)을 띄워 키를 봉인하게 한 뒤, Tauri판이 같은 키를 읽는지 본다(scripts/tauri-key-check.ts). 두 아키텍처 모두 통과했다.
   - 보이는 창 확인(macOS): 창, 세션, 질문, 키체인 저장과 다시 읽기, 터미널 호스트, 한 번만 실행, 앱을 다시 켠 뒤 터미널 유지, 확인 대화상자(취소하면 실행하지 않는다), 폴더 고르기, 창을 닫아도 앱 유지, Dock으로 다시 열기, 알림 누르기를 확인했다. 시험 번들은 번들 id를 따로 두고(`io.github.choco5958.switchboard.check`) 버전을 9.9.9로 올려 만든다. 실제 번들 id로 만든 시험 앱은 Dock이나 업데이트가 실제 환경으로 다시 띄울 수 있다. 아직 확인하지 못한 것: 서명이 바뀐 뒤 키체인이 묻는지, 알림을 거두는 것이 알림 센터에서 실제로 사라지는지.
   - 전환: release.yml에서 Electron판 build 잡을 빼고 tauri-mac.yml(`artifact: dist-mac`)과 tauri-check.yml(`artifact: dist`)을 부른다. release 잡은 두 잡을 기다린다.
   - Windows 업데이트: 설치를 PowerShell에 넘기던 때는 CI에서 설치가 한 번도 시작되지 않았다(위의 콘솔 문제). 앱이 끝난 뒤 설치를 넘기는 부분만 Windows 러너에서 따로 돌려 원인을 찾았고, Node로 바꾼 뒤 Windows x64의 스스로 하는 업데이트와 ARM64 Windows에서 x64판을 거쳐 ARM64판으로 바뀌기가 통과했다(tauri-check.yml 41953459264). 설치 프로그램이 끝난 직후에는 설치 파일이 잠깐 잠겨 있을 수 있어(ARM64에서 EPERM), 앱을 먼저 다시 띄우고 지우기는 여러 번 시도한다.

## 패키지 만들기 (macOS)

```sh
pnpm build && pnpm tauri:stage            # Node 받기와 out/tauri/node 준비
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri build --bundles app
```

릴리스 파일(두 칩)은 tauri-mac.yml과 같은 순서로 만든다.

```sh
for pair in aarch64-apple-darwin:arm64 x86_64-apple-darwin:x64; do
  node scripts/fetch-node.ts ${pair%%:*} && node scripts/stage-tauri.ts darwin ${pair##*:}
  pnpm tauri build --target ${pair%%:*} --bundles app
done
node scripts/pack-tauri-mac.ts dist
```

설치된 모양으로 돌 때(앱 안에 switchboard-node와 Resources/node가 있을 때)는 Electron판처럼 `~/.claude-ide/runtime`에 복사본을 만들고 실행 스크립트를 쓴다. `SWITCHBOARD_REPO`를 주면 저장소 모양으로 돈다.

## 저장소에서 띄우기

```sh
pnpm build                      # 화면, Node 쪽, Node 호스트(out/host/main.mjs)
cd src-tauri && cargo build --release
./target/release/switchboard     # 시스템의 node로 호스트를 띄운다
```

이 실행은 진짜 `~/.claude-ide`의 브리지를 쓰고, 자기가 띄우지 않은 브리지를 교체한다. 시험할 때는 `HOME`, `CLAUDE_IDE_SOCKET`, `CLAUDE_IDE_DB`를 임시 폴더로 돌린다. `CLAUDE_IDE_CAPTURE_JS`를 주면 창을 띄우지 않고 페이지가 뜬 뒤 그 스크립트를 돌리며, 스크립트는 `capture_log` 명령으로 결과를 남긴다.

## 지금까지 알게 된 것

- **숨은 창의 페이지:** WebKit은 보이지 않는 창의 페이지를 멈춘다. 답 보내기의 5초 되돌리기처럼 페이지가 뒤에서 하는 일이 있어서, 주 창은 `backgroundThrottling: disabled`로 둔다. 그래도 한 번도 보인 적 없는 창은 그리지 않아서, 숨은 시험에서는 터미널 글자가 화면에 그려지는지 확인할 수 없다.
- **App Nap:** 앱 번들로 띄운 Tauri판은 창이 안 보이면 macOS가 재워서 페이지의 타이머가 거의 멈춘다(3초 대기가 2분 넘게 끝나지 않았다). 번들 밖의 실행 파일로 띄우면 생기지 않아서 저장소 모양의 시험에서는 보이지 않았다. Rust 셸이 시작할 때 NSProcessInfo 활동을 걸어 App Nap을 끈다(컴퓨터의 잠자기는 막지 않는다).
- **페이지가 호스트보다 먼저 뜬다:** Electron판은 앱 논리가 시작된 뒤 창을 만들지만, Tauri판은 창의 페이지가 곧바로 뜬다. 그 사이의 호출은 브리지가 없어 빈 상태를 받았고, 바뀐 것이 생길 때까지 세션 목록이 비어 있었다. 이제 페이지의 호출은 호스트가 ready를 보낼 때까지 기다린다.
- **undefined 인자:** Electron IPC는 undefined를 그대로 넘기고 처리기는 그것을 null과 구분한다. JSON에는 undefined가 없어서 Tauri 쪽은 표시를 붙여 보내고 호스트가 되살린다(src/shared/ideCalls.ts).
- **시험 실행과 OS 기능:** `CLAUDE_IDE_CAPTURE_JS`가 있으면 키체인, 대화상자, 알림을 건드리지 않는다. 키는 실행마다 새로 만들고(그래서 터미널 호스트 대신 Node 호스트 안에서 터미널이 돈다), 확인 대화상자는 취소로, 폴더 고르기는 고르지 않음으로 답하고, 알림은 로그에만 남긴다.
- **WebKitGTK의 화면 찍기:** 한 번도 화면에 나오지 않은 창은 그리지 않아서 찍히지 않는다. 숨긴 확인을 가상 화면(Xvfb)에서 할 때는 `CLAUDE_IDE_CAPTURE_SHOW=1`로 창을 띄운다.
- **Windows의 경로:** Tauri의 resource_dir는 Windows에서 `\\?\C:\...` 모양을 돌려주고, Node는 그 경로의 스크립트를 실행하지 못한다(`EISDIR lstat 'C:'`). 셸이 dunce로 일반 경로로 바꾼 뒤 호스트에 넘긴다.
- **WebView2와 동기 명령:** 동기 명령은 메인 스레드에서 도는데, WebView2는 새 웹뷰의 준비도 그 스레드에서 끝내야 해서 동기 명령 안에서 웹뷰를 만들면 멈춘다. 내장 브라우저를 여는 browser_place는 비동기 명령이다.
- **명령의 답과 이벤트의 순서:** Tauri는 명령의 답과 emit한 이벤트를 다른 길로 보내서, 페이지가 이벤트보다 답을 먼저 받을 수 있다. 앱을 켤 때 "연결 안 됨"에 머무는 문제가 이것이었다. 이제 호스트의 답과 이벤트를 모두 `ide:event` 하나로 주 웹뷰에 보내고, 페이지가 호출 번호로 답을 찾는다(src/renderer/src/tauriPage.ts). 내장 브라우저의 이벤트는 그대로 `emit`으로 보낸다. Windows에서 탐색 처리기 안의 `emit_to`가 페이지 불러오기를 막았다.
- **시험용 키체인 항목:** `CLAUDE_IDE_KEYCHAIN_SERVICE`에 서비스 이름 뒤에 `.이름`을 붙인 값을 주면 그 항목을 쓴다. 보이는 창 확인에서 진짜 키를 건드리지 않으려고 둔다.
- **Windows 확인용 HOME:** AppData\Roaming은 USERPROFILE을 따르지만 그 폴더가 있을 때만이다. 없으면 셸이 데이터 폴더를 찾지 못해 설치 폴더 안(`.tauri-data`)을 썼고, 업데이트 설치 파일도 거기 들어갔다. 확인 스크립트가 AppData 폴더를 미리 만든다.
- **Electron판 Linux x64의 glibc:** ubuntu-latest가 26.04로 바뀐 0.3.13부터 Electron판 x64의 node-pty가 glibc 2.42를 요구해 Ubuntu 24.04와 22.04에서 앱이 뜨지 않았다. 0.3.18부터 release.yml이 22.04에서 만들고 glibc 2.35 이하인지 확인한다.
- **macOS 임시 HOME:** 임시 HOME에는 기본 키체인이 없고, 긴 경로는 유닉스 소켓 길이 제한(104바이트)을 넘어 터미널 호스트가 뜨지 않는다. 보이는 창 확인은 Keychains를 연결하고 TMPDIR을 /tmp로 둔다.
- **WebView2의 DevTools 오류:** CDP 호출이 실패하면 WebView2는 "Class not registered", "The parameter is incorrect" 같은 HRESULT 메시지를 주고, CDP의 오류("Cannot find context with specified id")는 답 본문에만 있다. 앱 전용 세계를 다시 만들지 판단할 때 메시지 문구에 기대지 않는다.
- **macOS 알림:** notify-rust(mac-notification-sys)는 알림을 보낸 뒤 클릭을 기다리는 스레드가 0.1초 만에 "닫힘"으로 끝나서, 알림을 눌러도 앱에 아무것도 오지 않았다. 보낸 알림을 거둘 수도 없었다. 이제 macOS는 NSUserNotificationCenter를 직접 쓴다. 알림마다 식별자를 붙이고, delegate가 클릭을 받고, 답한 질문의 알림은 알림 센터에서 거둔다(Electron판 0.3.18과 같다). Windows와 Linux는 notify-rust 그대로다.
- **주 창 찾기:** 내장 브라우저의 웹뷰가 주 창에 붙으면 그 창은 웹뷰 창이 아니게 되어 `get_webview_window("main")`이 아무것도 찾지 못한다. 그래서 Dock으로 다시 열기, 알림을 눌러 창 가져오기, 두 번째 실행 때 창 보이기, Dock 배지가 모두 조용히 동작하지 않았다. `get_window("main")`으로 찾는다.
- **사람이 봐야 확인되는 것:** 키체인(처음 저장, 다시 읽기, 거절, Electron판 키 이어받기), 확인 대화상자, 폴더 고르기, 알림 누르기, 한 번만 실행, 창을 닫았다가 Dock으로 다시 열기. 잠자기 막기와 자리 비움은 Rust 단위 테스트로 확인했다.

## 주의

- 시험용 실행은 항상 캡처 모드나 화면 밖에서 한다. 저장소에서 띄운 Electron판과 설치된 앱은 같은 데이터 폴더를 쓴다.
- 이전 중에도 Electron판 테스트와 릴리스가 깨지면 안 된다.
