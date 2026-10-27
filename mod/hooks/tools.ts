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
  worktreeRepo: '레포 경로. 세션이 여러 레포의 상위 폴더에서 돌 때 적는다 (생략하면 세션 폴더)',
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
  worktreeRepo: 'Repo path. Give it when the session runs in a folder above several repos (the session folder when left out)',
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
