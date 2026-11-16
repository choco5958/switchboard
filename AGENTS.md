# 에이전트 작업 규칙

Switchboard는 공개 저장소다. 이 파일은 이 저장소에서 일하는 코딩 에이전트를 위한 규칙이다. 앱 소개와 개발 명령은 `README.md`에 있다.

## 글을 쓰기 전에

- 화면 글(`src/shared/i18n/*.ts`)과 README의 문구를 쓰거나 고치기 전에 `docs/용어.md`를 읽는다. 같은 대상을 같은 말로 부르는 표와 문체 규칙이 있다.
- 화면 글은 `src/shared/i18n/`에 한국어(`ko.ts`), 영어(`en.ts`), 일본어(`ja.ts`), 중국어 간체(`zh-CN.ts`)로 나뉘어 있다. 키를 더하거나 고치면 네 사전을 함께 고친다. `i18n.test.ts`가 빠진 키와 줄표, 가운데점을 검사한다.
- README는 `README.md`(영어), `README.ko.md`, `README.ja.md`, `README.zh-CN.md` 네 개다. 내용을 바꾸면 네 파일을 함께 바꾼다. 각 파일 맨 위의 언어 링크 줄도 같다.
- 줄표(em dash, en dash)와 가운데점은 쓰지 않는다.
- `docs/` 아래 한국어 문서 가운데 `tauri-이전.md`, `계정-여러-개.md`, `에이전트-기능-맞추기.md`, `에이전트-대등하게.md`는 날짜가 적힌 결정 이력이다. 지난 내용을 고쳐 쓰지 않는다. 바뀐 점은 날짜를 붙여 덧붙인다. `docs/용어.md`는 지금 기준의 표라서 그대로 고친다.

## 시험

- `pnpm test`와 `pnpm typecheck`를 쓴다. 시험은 `package.json`의 `test` 스크립트가 정한 대로 `node --test`(bridge, mcp, mod, scripts)와 `vitest`(src)로 돈다.
- 시험은 임시 HOME에서 돌아야 한다. `scripts/test-env.ts`가 시험 전에 HOME과 USERPROFILE을 빈 임시 폴더로 바꾸고, 계정과 에이전트 CLI 상태를 가리키는 환경 변수(`ANTHROPIC_`, `CLAUDE`, `CODEX_`, `SWITCHBOARD_` 등)를 지운다. 이유는 시험이 실제 `~/.claude`나 `~/.claude-ide`를 읽거나 쓰지 않게 하려는 것이다.
- 새 시험 파일이 `node --test`로 돌면 `package.json`의 `test` 스크립트가 그 폴더를 포함하는지 본다. 직접 실행할 때는 `node --import ./scripts/test-env.ts --test <파일>`처럼 같은 설정 파일을 앞에 둔다. vitest는 `vitest.config.ts`가 설정 파일을 불러온다.
- 화면 확인은 실제 데이터와 떨어진 브리지로 한다. 방법은 README의 「Folders and development commands」 절에 있다.

## 공개 저장소 규칙

- 개인 경로(사용자 홈 폴더의 절대 경로), 비밀값(키, 토큰, 비밀번호), 계정 이름, 이 저장소 밖의 다른 프로젝트 이름을 파일, 시험, 커밋 메시지에 쓰지 않는다.
- 시험에는 가짜 값과 임시 폴더만 쓴다.
- 문서 예시의 경로는 `~/.claude-ide`처럼 홈 기준으로 적는다.

## 이름

- 앱 이름은 Switchboard다. 다만 패키지 이름 `claude-ide`, 저장 폴더 `~/.claude-ide`, 환경 변수 `CLAUDE_IDE_*`, mod 이름 `ide-bridge`는 식별자라서 그대로 둔다. 설치된 앱과 mod가 이 이름으로 데이터를 찾는다(`docs/tauri-이전.md`의 데이터 폴더 항목). 화면 글에서는 「IDE」라고 부르지 않는다.

## 올리기와 릴리스

- 커밋 제목은 한국어로 쓴다. 대개 「영역: 한 일」 꼴이고 릴리스 커밋은 `Switchboard <버전>`이다(`git log --oneline`으로 본다).
- `main`에 푸시하거나 풀 리퀘스트를 열면 `.github/workflows/test.yml`이 형식 검사와 시험을 돌린다.
- 릴리스는 `v*` 태그를 푸시할 때 `.github/workflows/release.yml`이 만든다. 태그의 버전은 `package.json`, `mcp/server.ts`의 `VERSION`, `mod/.claude-plugin/plugin.json`의 버전과 모두 같아야 한다. 하나라도 다르면 릴리스가 멈춘다.
- 업데이트 파일의 서명 키는 저장소에 없다. 서명을 시험하려고 키를 만들거나 저장소에 넣지 않는다.
