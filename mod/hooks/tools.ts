import { t, type Lang } from './i18n.ts'

// The tools the mod registers, described to the model in Korean for ko and in
// English for every other language. Names and enum values are the bridge's API
// and never change with the language.

const KO = {
  ask:
    '사람의 결정이 필요할 때 질문을 Switchboard 결정 대기 큐에 올린다. AskUserQuestion 대신 쓴다. ' +
    '호출은 바로 끝나고 질문 번호(Q번호)를 돌려준다. 답을 기다리며 멈추지 말고, 이 질문과 무관한 작업을 계속한다. ' +
    '사람이 답하면 "[Switchboard] Q번호 답이 왔습니다"로 시작하는 프롬프트가 들어오며, 그때 멈춰 둔 작업을 이어 간다.',
  askQuestion: '사람이 정할 질문 한 문장',
  askTask: '이 질문이 속한 작업 제목 (set_task와 같은 제목)',
  askBody: '배경과 선택지별 영향. 짧은 줄 몇 개',
  askOptions: '선택지. key는 a, b, c처럼 한 글자',
  askRecommend: '추천하는 선택지의 key',
  askReason: '추천 이유 한 줄',
  task:
    'Switchboard 작업 목록에 작업을 만들거나 갱신한다. 작업을 시작할 때, 단계(요구, 설계, 작업, 완료)가 바뀔 때, ' +
    '지금 하는 일이 바뀔 때 부른다. 같은 title이면 같은 작업이다. why, what, result, artifact, tests, branch는 IDE 작업 머리에 ' +
    '보이는 요약이니 알게 되는 대로 채우고, 준 칸만 바뀐다.',
  taskTitle: '작업 제목. 같은 제목이면 같은 작업으로 갱신된다',
  taskNow: '지금 하는 일 한 줄',
  taskWhy: '왜: 이 작업을 하는 이유, 사용자 요청 한 줄',
  taskWhat: '무엇: 만들거나 고치는 것 한 줄',
  taskResult: '마지막 결과: 가장 최근에 끝난 일과 판정 (예: PR #366 머지해도 됨)',
  taskArtifact: '산출물: PR, 문서, 배포 등 (예: PR #344)',
  taskTests: '시험: 결과 요약 (예: 통과 304, 실패 0)',
  taskBranch: '작업 브랜치',
  plan:
    '작업을 노드(시험, 확인, 구현, 검토 단위)로 나눠 Switchboard 진행 그래프에 올린다. 계획을 세우거나 바꿀 때 부른다. ' +
    'after로 선행 노드를 적으면 그래프에서 선으로 이어진다.',
  planTask: '작업 제목 (set_task와 같은 제목)',
  planNodes: '작업을 나눈 노드. 이미 있는 key는 덮어쓰고, 빠진 노드는 그대로 남는다',
  planKey: '노드 id. 영문 소문자와 숫자, 하이픈',
  planTitle: '노드에서 할 일 한 줄',
  planAfter: '먼저 끝나야 하는 노드 key 목록',
  worktree:
    '노드 하나에 Orca 워크트리(새 브랜치의 작업 폴더)를 만들어 연결한다. 코드를 고치는 구현 노드를 서브에이전트에게 맡길 때 부른다. ' +
    '읽기 전용 검토나 문서 노드에는 부르지 않는다. 돌려받은 경로를 서브에이전트 프롬프트에 넣어 그 안에서 일하게 한다.',
  worktreeTask: '작업 제목',
  worktreeKey: '워크트리를 줄 노드 key',
  worktreeBase: '기준 브랜치 (생략하면 레포 기본 브랜치)',
  worktreeRepo: '레포 경로. 세션이 여러 레포의 상위 폴더에서 돌 때 그 안의 레포를 적는다 (생략하면 세션 폴더)',
  node:
    '노드 상태를 바꾼다. 서브에이전트를 노드에 보낼 때 "지금", 끝나면 "끝", 막히면 "실패"로 부른다. ' +
    '노드를 맡기는 Agent 호출의 description은 "[작업 제목::노드 key] 할 일" 형식으로 써야 IDE 작업자 줄에 연결된다. ' +
    '끝난 노드를 다시 "지금"으로 바꾸면 회차가 올라간다(검토 지적 반영 등).',
  nodeTask: '작업 제목',
  nodeKey: '노드 key',
  nodeNote: '결과나 막힌 점 한 줄 (PR 번호, 시험 결과 등)',
  open:
    'Switchboard의 다이나믹 디버깅 탭에서 개발 서버나 웹 페이지를 연다. 사용자가 "검수 앱 8951 열어줘"처럼 화면을 IDE에서 보자고 할 때 부른다. ' +
    'url만 주면 그 주소를 열고, repo와 command를 함께 주면 개발 서버 대상으로 등록하거나 고친 뒤 IDE가 서버를 띄우고 응답하면 연다. ' +
    '같은 포트나 같은 이름의 대상이 이미 있으면 그 대상을 쓴다. 이 도구로 맡긴 개발 서버는 IDE가 출력과 재시작을 관리한다.',
  openUrl: '열 주소. 포트만 들었으면 http://127.0.0.1:포트',
  openName: '개발 서버 대상 이름 (예: 검수 앱 main). 같은 이름이나 같은 포트의 대상이 있으면 그 대상을 고친다',
  openRepo: '개발 서버를 띄울 레포 폴더. 상대 경로는 세션 폴더 기준 (command만 주면 세션 폴더)',
  openCommand: '개발 서버를 띄우는 명령 (예: pnpm dev --port 8951). 주면 IDE가 서버를 새로 띄운다',
  peers:
    'Switchboard에 연결된 다른 세션 목록을 본다: 세션 id, 프로젝트, 폴더, 에이전트, 지금 하는 작업. ' +
    '다른 프로젝트의 코드, API, 설정처럼 그 세션이 더 잘 아는 일이 생기면 먼저 부르고, 작업 제목과 폴더로 맞는 세션을 고른다.',
  send:
    '다른 세션에 메시지를 보낸다. 호출은 바로 끝난다. 요청(expectsReply true, 기본값)을 보냈으면 턴을 끝내고, 기다리며 폴링하거나 sleep하지 않는다. ' +
    '답은 다음 턴에 "[Switchboard] ...이(가) 보낸 메시지"로 들어온다. 받은 세션은 이 대화와 메모리를 볼 수 없으니, 혼자 읽어도 되는 메시지 하나로 쓴다: ' +
    '목표, 필요한 맥락, 시도한 것, 사용자가 승인한 위험한 작업과 하지 말아야 할 작업, 끝났다고 볼 기준. ' +
    '받은 요청에 답할 때는 replyTo에 그 메시지 id를 준다(to는 생략). 정보만 알릴 때는 expectsReply false. ' +
    '같은 요청을 반복해 보내지 않고, 받은 요청을 보낸 세션에 되돌려 맡기지 않으며, 사용자의 제한이나 안전 확인을 피하려고 다른 세션을 쓰지 않는다. ' +
    '한 요청에서 시작해 세션끼리 맡기는 요청은 모두 합쳐 8번까지다. 받은 세션의 연결이 끊기거나 턴이 중단되면 답이 오지 않는다는 알림이 들어온다.',
  sendTo: '받을 세션 id 목록 (list_sessions의 id). 답장이면 생략',
  sendText: '보낼 메시지',
  sendReplyTo: '답하는 메시지 id (예: m12)',
  sendExpects: '답을 바라면 true(기본값), 정보만 알리면 false',
  cancel:
    '이 세션이 send_to_session으로 맡긴 요청을 취소한다. 사용자가 방향을 바꿨거나 더 필요 없어졌을 때 쓴다. ' +
    '아직 전달되지 않은 요청은 들어가지 않고, 받은 세션의 턴이 그 요청만 처리하고 있으면 턴을 멈춘다. 받은 세션은 다음 턴에 취소 사실과 이유를 읽는다. 자기가 보낸 요청만 취소할 수 있다.',
  cancelIds: '취소할 요청 id 목록 (send_to_session이 돌려준 m번호)',
  cancelReason: '받은 세션에 알릴 취소 이유 한 줄',
  noUpdate: '예약 프롬프트 실행에서 사람에게 알릴 것이 없을 때 부른다. 알림 없이 조용히 끝난 실행으로 기록된다. 예약 실행이 아닐 때는 부르지 않는다.',
  reportFailure: '예약 프롬프트 실행에서 할 일을 해내지 못했을 때 이유와 함께 부른다. 실패한 실행으로 기록되고 사람에게 알린다.',
  reportReason: '못 한 이유 한 줄',
  awaitEvent:
    '빌드, 배포, 다른 사람의 확인처럼 이번 턴 밖에서 일어날 일을 기다려야 할 때 대기를 연다. 대기 id(w번호)를 사용자에게 알리고 턴을 끝낸다. 폴링하거나 sleep하지 않는다. ' +
    '그 일이 일어나면 셸의 "switchboard fire w번호"로 이 요청이 다시 들어온다(예: long-job; switchboard fire w3).',
  awaitNote: '무엇을 기다리고, 일어나면 무엇을 할지 한두 줄',
  closeWait: '더 기다릴 필요가 없어진 대기를 닫는다.',
  closeWaitId: '닫을 대기 id (예: w3)',
  browserSnapshot:
    'Switchboard 내장 브라우저에 지금 보이는 로컬 페이지를 읽는다: 주소, 제목, 누르거나 입력할 수 있는 요소 목록([ref] 역할 "이름"), 보이는 글. ' +
    '화면을 확인하거나 고친 결과를 검증할 때 쓴다. ref는 이번 읽기에서만 유효하다. 브라우저 탭이 앞으로 나와 사람이 볼 수 있다. 로컬 개발 서버만 다룬다.',
  browserClick: 'browser_snapshot의 ref로 요소를 실제 마우스 입력으로 누른다. 다른 요소가 덮고 있으면 거절된다. 누른 뒤의 새 읽기를 돌려준다.',
  browserRef: 'browser_snapshot이 준 ref (예: 3:12)',
  browserType: 'ref의 입력칸에 글을 넣는다(있던 내용은 바뀐다). submit이 true면 Enter를 누른다. 넣은 뒤의 새 읽기를 돌려준다.',
  browserText: '넣을 글',
  browserSubmit: '넣은 뒤 Enter를 누를지',
  browserNavigate: '내장 브라우저로 이 컴퓨터의 주소(localhost, 127.0.0.1, ::1, 이름.localhost)를 연다. 사설망 주소와 이름.local은 사람이 설정에서 허용했을 때만 열린다. 열린 뒤의 읽기를 돌려준다.',
  browserUrl: '열 주소',
  browserConsole: '지금 페이지의 콘솔 경고와 오류, 실패한 요청(400 이상, 응답 없음)을 최근 것부터 보여 준다.',
  browserScreenshot: '내장 브라우저 화면을 PNG로 저장하고 경로를 돌려준다. 그 파일을 읽어 화면을 볼 수 있다.',
}

const EN: typeof KO = {
  ask:
    'Puts a question that needs a person\'s decision into the Switchboard decision queue. Use it instead of AskUserQuestion. ' +
    'The call returns at once with the question number (Q number). Do not stop to wait for the answer; carry on with work unrelated to this question. ' +
    'When the person answers, a prompt starting with "[Switchboard] Q<number>" arrives with the answer; pick up the work you set aside then.',
  askQuestion: 'The question for the person to decide, in one sentence',
  askTask: 'Title of the task this question belongs to (the same title as in set_task)',
  askBody: 'Background and the effect of each option. A few short lines',
  askOptions: 'The options. Each key is one letter, like a, b, c',
  askRecommend: 'Key of the recommended option',
  askReason: 'Why it is recommended, in one line',
  task:
    'Creates or updates a task in the Switchboard task list. Call it when a task starts, when its stage changes ' +
    '(stage values: 요구 requirements, 설계 design, 작업 build, 완료 done), and when the current work changes. ' +
    'The same title means the same task. status values: 하는 중 active, 대기 waiting, 보관 archived. ' +
    'why, what, result, artifact, tests and branch are the summary shown at the head of the task in the IDE: fill them in as you learn them; only the fields you pass change.',
  taskTitle: 'Task title. The same title updates the same task',
  taskNow: 'What is being done now, in one line',
  taskWhy: 'Why: the reason for this task, the user\'s request in one line',
  taskWhat: 'What: what is being built or fixed, in one line',
  taskResult: 'Latest result: the most recent thing finished and its verdict (e.g. PR #366 is fine to merge)',
  taskArtifact: 'Deliverable: a PR, document, deployment and so on (e.g. PR #344)',
  taskTests: 'Tests: a summary of the results (e.g. 304 passed, 0 failed)',
  taskBranch: 'Working branch',
  plan:
    'Splits a task into nodes (units of test, check, build, review) and puts them on the Switchboard progress graph. ' +
    'Call it when making or changing a plan. Nodes named in after are joined by lines in the graph. ' +
    'kind values: 시험 test, 확인 check, 구현 build, 검토 review, 기타 other. ' +
    'owner values: 작업자 worker, 검토자 reviewer, 사용자 user, 오케스트레이터 orchestrator.',
  planTask: 'Task title (the same title as in set_task)',
  planNodes: 'The nodes the task is split into. An existing key is overwritten; nodes left out stay as they are',
  planKey: 'Node id: lowercase letters, digits and hyphens',
  planTitle: 'What the node does, in one line',
  planAfter: 'Keys of the nodes that must finish first',
  worktree:
    'Creates an Orca worktree (a working folder on a new branch) for one node and links it. Call it when giving a build node that changes code to a subagent. ' +
    'Do not call it for read-only review or documentation nodes. Put the returned path in the subagent\'s prompt and have it work inside it.',
  worktreeTask: 'Task title',
  worktreeKey: 'Key of the node that gets the worktree',
  worktreeBase: 'Base branch (the repo\'s default branch when left out)',
  worktreeRepo: 'Repo path. Give it when the session runs in a folder above several repos: one of the repos inside it (the session folder when left out)',
  node:
    'Changes a node\'s status. Call it with "지금" (now) when sending a subagent to the node, "끝" (done) when it finishes, "실패" (failed) when it is blocked. ' +
    'The description of the Agent call that takes the node must read "[task title::node key] what to do" to link to the worker row in the IDE. ' +
    'Setting a finished node back to "지금" raises its round (for example, to address review comments).',
  nodeTask: 'Task title',
  nodeKey: 'Node key',
  nodeNote: 'The result or what is blocking, in one line (PR number, test results and so on)',
  open:
    'Opens a dev server or web page in the Switchboard dynamic debugging tab. Call it when the user asks to see a screen in the IDE, like "open the review app on 8951". ' +
    'With url alone it opens that address; with repo and command as well it registers or updates a dev server target, and the IDE starts the server and opens the page once it answers. ' +
    'A target with the same port or name is reused. The IDE manages the output and restarts of dev servers handed over with this tool.',
  openUrl: 'Address to open. When only a port is given, http://127.0.0.1:<port>',
  openName: 'Dev server target name (e.g. review app main). A target with the same name or port is updated',
  openRepo: 'Repo folder to start the dev server in. A relative path is taken from the session folder (the session folder when only command is given)',
  openCommand: 'Command that starts the dev server (e.g. pnpm dev --port 8951). When given, the IDE starts the server again',
  peers:
    'Lists the other sessions connected to Switchboard: session id, project, folder, agent and the task each works on. ' +
    'Call it first when work comes up that another session knows better, such as the code, API or settings of another project, and pick the session by its task title and folder.',
  send:
    'Sends a message to other sessions. The call returns at once. After sending a request (expectsReply true, the default) end your turn; do not poll or sleep while waiting. ' +
    'The answer arrives in a later turn as "[Switchboard] A message from ...". The receiving session cannot see this conversation or your memory, so write one message that stands alone: ' +
    'the goal, the context it needs, what you tried, which risky actions the user approved and which it must not do, and what counts as finished. ' +
    'To answer a request you received, give its message id as replyTo (leave out to). For information only, set expectsReply false. ' +
    'Do not send the same request again, do not hand a request back to the session that sent it, and never use another session to get around a user limit or a safety check. ' +
    'Requests handed between sessions that start from one request are capped at 8 in all. If the receiving session disconnects or its turn is interrupted, a notice says no answer is coming.',
  sendTo: 'Ids of the sessions to send to (ids from list_sessions). Leave out on a reply',
  sendText: 'The message',
  sendReplyTo: 'Id of the message this answers (e.g. m12)',
  sendExpects: 'true (the default) when you want an answer, false for information only',
  cancel:
    'Cancels requests this session gave with send_to_session, when the user changed course or the work is no longer needed. ' +
    'A request not delivered yet never goes in; if the receiving session\'s turn is working on these requests alone, the turn stops. The receiving session reads the cancellation and its reason in its next turn. Only requests this session sent can be cancelled.',
  cancelIds: 'Ids of the requests to cancel (the m numbers send_to_session returned)',
  cancelReason: 'One line telling the receiving session why',
  noUpdate: 'Call it in a scheduled prompt run when there is nothing to tell the person. The run is recorded as ended quietly, with no notification. Do not call it outside a scheduled run.',
  reportFailure: 'Call it with the reason in a scheduled prompt run when the work could not be done. The run is recorded as failed and the person is told.',
  reportReason: 'Why it could not be done, in one line',
  awaitEvent:
    'Opens a wait when the work needs something that happens outside this turn, such as a build, a deploy or someone else\'s check. Tell the user the wait id (w number) and end your turn; do not poll or sleep. ' +
    'When it happens, "switchboard fire w<number>" in a shell puts this request back into the session (for example: long-job; switchboard fire w3).',
  awaitNote: 'What you wait for and what to do when it happens, in a line or two',
  closeWait: 'Closes a wait that is no longer needed.',
  closeWaitId: 'Id of the wait to close (e.g. w3)',
  browserSnapshot:
    'Reads the local page shown in the Switchboard in-app browser: address, title, the elements that can be pressed or typed into ([ref] role "name"), and the visible text. ' +
    'Use it to check a screen or verify a fix. A ref holds only for this reading. The browser tab comes to the front, so the person can watch. Local dev servers only.',
  browserClick: 'Presses an element by its browser_snapshot ref, with real mouse input. Refused when another element covers it. Returns a fresh reading.',
  browserRef: 'A ref from browser_snapshot (e.g. 3:12)',
  browserType: 'Puts text into the field of a ref (what was there is replaced). With submit true it presses Enter. Returns a fresh reading.',
  browserText: 'The text to put in',
  browserSubmit: 'Whether to press Enter afterwards',
  browserNavigate: 'Opens an address on this computer (localhost, 127.0.0.1, ::1, name.localhost) in the in-app browser. Private network addresses and name.local open only when the person allowed them in settings. Returns the reading once it loaded.',
  browserUrl: 'The address to open',
  browserConsole: 'Shows the page\'s console warnings and errors and its failed requests (status 400 or more, or no answer), newest last.',
  browserScreenshot: 'Saves the in-app browser\'s screen as a PNG and returns the path. Read that file to see the screen.',
}

const STAGES = ['요구', '설계', '작업', '완료']

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

export function toolText(lang: Lang): typeof KO {
  return lang === 'ko' ? KO : EN
}

export function toolDefs(lang: Lang): ToolDef[] {
  const d = toolText(lang)
  return [
    {
      name: 'ask_decision',
      description: d.ask,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: d.askQuestion },
          task: { type: 'string', description: d.askTask },
          body: { type: 'string', description: d.askBody },
          options: {
            type: 'array',
            description: d.askOptions,
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, label: { type: 'string' } },
              required: ['key', 'label'],
            },
          },
          recommend: { type: 'string', description: d.askRecommend },
          reason: { type: 'string', description: d.askReason },
        },
        required: ['question', 'options'],
      },
    },
    {
      name: 'set_task',
      description: d.task,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: d.taskTitle },
          stage: { type: 'string', enum: STAGES },
          status: { type: 'string', enum: ['하는 중', '대기', '보관'] },
          now: { type: 'string', description: d.taskNow },
          why: { type: 'string', description: d.taskWhy },
          what: { type: 'string', description: d.taskWhat },
          result: { type: 'string', description: d.taskResult },
          artifact: { type: 'string', description: d.taskArtifact },
          tests: { type: 'string', description: d.taskTests },
          branch: { type: 'string', description: d.taskBranch },
        },
        required: ['title'],
      },
    },
    {
      name: 'plan_nodes',
      description: d.plan,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: d.planTask },
          nodes: {
            type: 'array',
            description: d.planNodes,
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: d.planKey },
                title: { type: 'string', description: d.planTitle },
                kind: { type: 'string', enum: ['시험', '확인', '구현', '검토', '기타'] },
                owner: { type: 'string', enum: ['작업자', '검토자', '사용자', '오케스트레이터'] },
                stage: { type: 'string', enum: STAGES },
                after: { type: 'array', items: { type: 'string' }, description: d.planAfter },
              },
              required: ['key', 'title'],
            },
          },
        },
        required: ['task', 'nodes'],
      },
    },
    {
      name: 'node_worktree',
      description: d.worktree,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: d.worktreeTask },
          key: { type: 'string', description: d.worktreeKey },
          base: { type: 'string', description: d.worktreeBase },
          repo: { type: 'string', description: d.worktreeRepo },
        },
        required: ['task', 'key'],
      },
    },
    {
      name: 'list_sessions',
      description: d.peers,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_to_session',
      description: d.send,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: d.sendTo },
          text: { type: 'string', description: d.sendText },
          replyTo: { type: 'string', description: d.sendReplyTo },
          expectsReply: { type: 'boolean', description: d.sendExpects },
        },
        required: ['text'],
      },
    },
    {
      name: 'cancel_request',
      description: d.cancel,
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: d.cancelIds },
          reason: { type: 'string', description: d.cancelReason },
        },
        required: ['ids'],
      },
    },
    {
      name: 'routine_no_update',
      description: d.noUpdate,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'routine_report_failure',
      description: d.reportFailure,
      inputSchema: { type: 'object', properties: { reason: { type: 'string', description: d.reportReason } }, required: ['reason'] },
    },
    {
      name: 'await_event',
      description: d.awaitEvent,
      inputSchema: { type: 'object', properties: { note: { type: 'string', description: d.awaitNote } }, required: ['note'] },
    },
    {
      name: 'close_wait',
      description: d.closeWait,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: d.closeWaitId } }, required: ['id'] },
    },
    { name: 'browser_snapshot', description: d.browserSnapshot, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'browser_click',
      description: d.browserClick,
      inputSchema: { type: 'object', properties: { ref: { type: 'string', description: d.browserRef } }, required: ['ref'] },
    },
    {
      name: 'browser_type',
      description: d.browserType,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: d.browserRef },
          text: { type: 'string', description: d.browserText },
          submit: { type: 'boolean', description: d.browserSubmit },
        },
        required: ['ref', 'text'],
      },
    },
    {
      name: 'browser_navigate',
      description: d.browserNavigate,
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: d.browserUrl } }, required: ['url'] },
    },
    { name: 'browser_console', description: d.browserConsole, inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_screenshot', description: d.browserScreenshot, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'update_node',
      description: d.node,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: d.nodeTask },
          key: { type: 'string', description: d.nodeKey },
          status: { type: 'string', enum: ['대기', '지금', '끝', '실패'] },
          note: { type: 'string', description: d.nodeNote },
        },
        required: ['task', 'key', 'status'],
      },
    },
  ]
}

export function openToolDef(lang: Lang, name: string): ToolDef {
  const d = toolText(lang)
  return {
    name,
    description: d.open,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: d.openUrl },
        name: { type: 'string', description: d.openName },
        repo: { type: 'string', description: d.openRepo },
        command: { type: 'string', description: d.openCommand },
      },
      required: ['url'],
    },
  }
}

// open_in_ide's request body and result text, pure, so the MCP server (mcp/server.ts) shares them.
export type Reply = { ok: boolean; status: number; json: Record<string, unknown> }

export type OpenArgs = { url?: unknown; name?: unknown; repo?: unknown; command?: unknown }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// The body POST /dev/open takes. A relative folder is taken from the session's
// own folder, and a command without a folder runs there too.
export function openBody(args: OpenArgs, sessionId: string, root: string) {
  const command = text(args.command)
  let repo = text(args.repo)
  if (repo && !repo.startsWith('/') && !repo.startsWith('~/')) repo = `${root.replace(/\/+$/, '')}/${repo.replace(/^\.\//, '')}`
  if (!repo && command) repo = root
  return { url: text(args.url), name: text(args.name), repo, command, sessionId }
}

// What the session reads back.
export function openResultText(reply: Reply, lang: Lang = 'ko'): string {
  if (!reply.ok) return t(lang, 'dev.failed', { error: String(reply.json.error ?? t(lang, 'dev.status', { n: reply.status })) })
  const target = reply.json.target as { name?: string } | null
  const lines = [t(lang, 'dev.opening', { url: String(reply.json.url) })]
  if (target?.name) {
    if (reply.json.created) lines.push(t(lang, 'dev.created', { name: target.name }))
    else if (reply.json.restart) lines.push(t(lang, 'dev.restart', { name: target.name }))
    else lines.push(t(lang, 'dev.existing', { name: target.name }))
  }
  if (reply.json.ideWatching === false) lines.push(t(lang, 'dev.appOff'))
  return lines.join('\n')
}

// list_sessions and send_to_session results, shared by the mod and the MCP server.
export type Peer = { id: string; project: string; cwd: string; agent: string; live: boolean; state: string; task: string; now: string }

export function peersText(peers: readonly Peer[], lang: Lang): string {
  if (peers.length === 0) return t(lang, 'tool.peersNone')
  return [
    t(lang, 'tool.peersHead'),
    ...peers.map(p => {
      const state = !p.live ? t(lang, 'tool.peerOffline') : p.state === 'working' ? t(lang, 'tool.peerWorking') : t(lang, 'tool.peerIdle')
      const task = p.task ? ` | ${p.task}${p.now ? `: ${p.now}` : ''}` : ''
      return `- ${p.id} | ${p.project} | ${p.agent} | ${p.cwd} | ${state}${task}`
    }),
  ].join('\n')
}

export function sentText(json: Record<string, unknown>, expectsReply: boolean, lang: Lang): string {
  if (typeof json.answered === 'string') return t(lang, 'tool.sentAnswer', { id: json.answered })
  const ids = Array.isArray(json.ids) ? json.ids.join(', ') : ''
  if (json.duplicate) return t(lang, 'tool.sentAgain', { ids })
  return t(lang, expectsReply ? 'tool.sentRequest' : 'tool.sentInfo', { ids })
}

// cancel_request's result, one line per request (bridge POST /messages/cancel).
export function cancelText(json: Record<string, unknown>, lang: Lang): string {
  const results = (json.results ?? {}) as Record<string, string>
  const key = { queued: 'tool.cancelQueued', noted: 'tool.cancelNoted', stopped: 'tool.cancelStopped', done: 'tool.cancelDone' } as const
  return Object.entries(results)
    .map(([id, result]) => t(lang, key[result as keyof typeof key] ?? 'tool.cancelDone', { id }))
    .join('\n')
}

// node_worktree, shared by the mod and the MCP server. The model picks `repo` and `base`, and
// git and orca run there outside the permission checks, so: a base that would read as an
// option is refused, the repo must be the session's folder or one inside it, and the git run
// here starts no hook or fsmonitor of the repo. `stdout`: a command's output run in a folder,
// '' when it fails.
export const SAFE_GIT = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

// Whether `path` is `folder` or inside it; both absolute, with '/'.
export function insideFolder(path: string, folder: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/, '') || '/'
  const [p, f] = [trim(path), trim(folder)]
  return p === f || p.startsWith(f === '/' ? '/' : `${f}/`)
}

export async function worktreeRoot(
  stdout: (argv: string[], cwd: string) => Promise<string>,
  home: string,
  repo?: string,
  base?: string,
): Promise<{ root: string } | { refused: 'wt.badBase' | 'wt.outside' | 'wt.notRepo'; vars: Record<string, string> }> {
  if (base?.startsWith('-')) return { refused: 'wt.badBase', vars: { base } }
  const from = !repo ? home : repo.startsWith('/') ? repo : `${home.replace(/\/+$/, '')}/${repo.replace(/^\.\//, '')}`
  // Compared as the folders really are, so a symlink inside the session folder leads nowhere else.
  const real = async (dir: string) => (await stdout(['sh', '-c', 'pwd -P'], dir).catch(() => '')).trim()
  const realHome = await real(home)
  const realFrom = from === home ? realHome : await real(from)
  if (!realHome || !realFrom || !insideFolder(realFrom, realHome)) return { refused: 'wt.outside', vars: { path: from } }
  const root = (await stdout([...SAFE_GIT, 'rev-parse', '--show-toplevel'], from).catch(() => '')).trim()
  if (!root) return { refused: 'wt.notRepo', vars: { path: from } }
  // The repo the session folder is in, or one inside it; never one a repo's own config points elsewhere.
  if (!insideFolder(root, realHome) && !insideFolder(realHome, root)) return { refused: 'wt.outside', vars: { path: root } }
  return { root }
}

// The browser_* tools and the bridge action each asks for (bridge POST /browser/act).
export const BROWSER_TOOLS: Record<string, string> = {
  browser_snapshot: 'snapshot',
  browser_click: 'click',
  browser_type: 'type',
  browser_navigate: 'navigate',
  browser_console: 'console',
  browser_screenshot: 'screenshot',
}
