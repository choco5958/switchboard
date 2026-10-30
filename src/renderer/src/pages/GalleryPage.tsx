import type { ReactNode } from 'react'
import type { LogEvent, Question, Task } from '../../../shared/types'
import { nodeStatusSlug } from '../../../shared/i18n'
import { Icon } from '../Icons'
import { LogLines, NumberBadge, QueueItem, TaskItem } from '../parts'

// Every UI part with its real class names and static sample data, for judging a theme at a glance.
// Nothing here calls the bridge; buttons do nothing.

const NOW = Date.now()
const noop = () => undefined

const TASK: Task = {
  id: 1,
  session_id: 'sample',
  project: 'claude-ide',
  title: '테마 시스템과 부품 갤러리',
  stage: '작업',
  status: '하는 중',
  now: '테마 여덟 개를 화면으로 확인',
  created_at: NOW - 3 * 3600_000,
  updated_at: NOW - 120_000,
  why: '',
  what: '',
  result: '',
  artifact: '',
  tests: '',
  branch: 'themes',
  number: 3,
  archived_at: null,
  restored_at: NOW - 600_000,
}

const WAITING: Task = { ...TASK, id: 2, title: '빈 앱 E2E 실행', stage: '설계', status: '대기', now: '', number: 4, restored_at: null }

const QUESTION: Question = {
  id: 1397,
  session_id: 'sample',
  project: 'claude-ide',
  task_title: '테마 시스템과 부품 갤러리',
  question: '기본 테마를 A3로 둘까',
  body: '',
  options: '[]',
  recommend: 'a',
  reason: '',
  status: 'pending',
  choice: null,
  memo: null,
  created_at: NOW - 5 * 60_000,
  answered_at: null,
  delivered: 0,
  turn_id: '',
}

const EVENTS: LogEvent[] = [
  { id: 1, ts: NOW - 300_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '작업', text: '테마 파일 여덟 개를 만듦' },
  { id: 2, ts: NOW - 240_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '결정 대기', text: 'Q1397 기본 테마를 A3로 둘까' },
  { id: 3, ts: NOW - 180_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '답함', text: 'Q1397 (a) A3 기본' },
  { id: 4, ts: NOW - 120_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '전달', text: '세션에 답을 넣음' },
  { id: 5, ts: NOW - 60_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '노드', text: 'gallery 지금' },
]

const STAGES = ['요구', '설계', '작업', '완료']

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-part">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="gallery-row">{children}</div>
}

function Meter({ label, percent, level }: { label: string; percent: number; level: 'good' | 'warn' | 'bad' }) {
  return (
    <span className="meter">
      <span className="quiet small">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill ${level}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="small">{percent}%</span>
    </span>
  )
}

// Graph boxes laid out as TaskView does: 200 wide, 64 high, 236 apart, rows 84 apart.
const NODES = [
  { key: 'plan', title: '시험 케이스 기획', kind: '시험', owner: '작업자', status: '끝', note: 'PR #344', left: 16, top: 16 },
  { key: 'build', title: '테마 파일 구현', kind: '구현', owner: '작업자', status: '지금', note: '2회차', left: 252, top: 16 },
  { key: 'review', title: '화면 독립 검토', kind: '검토', owner: '검토자', status: '대기', note: '', left: 488, top: 16 },
  { key: 'decide', title: '사용자 결정', kind: '확인', owner: '사용자', status: '실패', note: '선택된 노드', left: 252, top: 100 },
]

function Graph() {
  const edge = (x1: number, y1: number, x2: number, y2: number, done: boolean) => {
    const bend = Math.max(24, (x2 - x1) / 2)
    return (
      <path
        d={`M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`}
        className={done ? 'edge done' : 'edge'}
        markerEnd="url(#gallery-arrow)"
      />
    )
  }
  return (
    <div className="graph-scroll">
      <div className="graph" style={{ width: 704, height: 184 }}>
        <svg className="edges" width={704} height={184}>
          <defs>
            <marker id="gallery-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="currentColor" />
            </marker>
          </defs>
          {edge(216, 48, 252, 48, true)}
          {edge(452, 48, 488, 48, false)}
          {edge(216, 48, 252, 132, true)}
        </svg>
        {NODES.map(node => (
          <div
            key={node.key}
            className={`node node-${node.status} ${node.key === 'decide' ? 'node-selected' : ''}`}
            data-status={nodeStatusSlug(node.status)}
            style={{ left: node.left, top: node.top, width: 200, height: 64 }}
          >
            <div className="node-title">
              <span className="kind">{node.kind}</span>
              {node.key === 'build' && <span className="kind">워크트리</span>}
              {node.title}
            </div>
            <div className="quiet small">
              {node.owner}, {node.status}
              {node.note ? `, ${node.note}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function GalleryPage() {
  return (
    <div className="card wide gallery">
      <h1>부품 갤러리</h1>
      <p className="quiet small">화면에 쓰는 부품을 실제 클래스 그대로 모았습니다. 테마를 바꾼 뒤 여기서 한눈에 확인합니다. 견본 데이터라 눌러도 아무 일이 일어나지 않습니다.</p>

      <Part title="글자와 색">
        <Row>
          <span>본문 글자</span>
          <span className="quiet">흐린 글자(quiet)</span>
          <span className="small">작은 글자</span>
          <span className="qid">Q1397</span>
          <span className="tag">[claude-ide]</span>
          <span className="count">3</span>
          <span className="mono">src/renderer/src/theme.ts</span>
          <span className="error">오류 문구</span>
          <span className="answered">답함 문구</span>
          <kbd>a</kbd>
          <kbd>⌘K</kbd>
        </Row>
      </Part>

      <Part title="버튼">
        <div className="actions">
          <button className="primary">(a) 보내기</button>
          <button>메모만 보내기</button>
          <button disabled>선택지를 고르세요</button>
        </div>
        <div className="node-detail">
          <div className="actions">
            <button>워크트리 정리</button>
            <button className="danger">변경을 잃어도 정리</button>
            <button disabled>정리 중</button>
          </div>
        </div>
        <Row>
          <button className="link">링크 버튼</button>
          <button className="link small">작은 링크</button>
          <button className="link" disabled>
            꺼진 링크
          </button>
        </Row>
        <div className="browser-bar">
          <button>뒤로</button>
          <input className="address" defaultValue="http://localhost:5173/" />
          <button className="primary">코멘트 모드</button>
        </div>
      </Part>

      <Part title="칩">
        <Row>
          <span className="chip">Opus 5.5</span>
          <span className="chip chip-warn">답 기다림</span>
          <span className="chip chip-good">연결</span>
          <span className="chip chip-bad">끊김</span>
          <span className="chip chip-on">에이전트 2</span>
          <button className="chip chip-button">진행 보고</button>
          <button className="chip chip-button chip-warn">결정 3</button>
        </Row>
        <Row>
          <span className="tag-chip">계획 없음</span>
          <span className="tag-chip warn">열린 질문 2</span>
          <span className="tag-chip accent">보관에서 되살림</span>
          <span className="recommend">추천</span>
        </Row>
      </Part>

      <Part title="번호 배지(작업 색 여섯 가지)">
        <Row>
          {[1, 2, 3, 4, 5, 6].map(number => (
            <NumberBadge key={number} task={{ number }} />
          ))}
          <NumberBadge task={{ number: 12 }} />
        </Row>
      </Part>

      <Part title="미터">
        <Row>
          <Meter label="5시간" percent={39} level="good" />
          <Meter label="주간" percent={81} level="warn" />
          <Meter label="컨텍스트" percent={94} level="bad" />
        </Row>
      </Part>

      <div className="gallery-grid">
        <Part title="작업 목록 항목">
          <div className="gallery-pane">
            <TaskItem task={TASK} active openQuestions={2} nodeCount={4} onClick={noop} />
            <TaskItem task={WAITING} active={false} openQuestions={0} nodeCount={0} onClick={noop} />
          </div>
        </Part>
        <Part title="결정 대기 항목">
          <div className="gallery-pane">
            <QueueItem q={QUESTION} active onClick={noop} />
            <QueueItem q={{ ...QUESTION, id: 1398, task_title: '금감원 무인 자동화', question: '재시도 상한을 3회로 할까' }} active={false} gone onClick={noop} />
          </div>
        </Part>
        <Part title="홈 카드와 통계">
          <div className="stat">
            <b>3</b>
            <span>진행 중 작업</span>
          </div>
          <div className="home-card">
            <div className="task-title">
              <NumberBadge task={TASK} /> {TASK.title}
            </div>
            <div className="quiet small">claude-ide, 작업, 노드 2/4, 2분 전</div>
            <div className="mini-stages">
              <span className="done" />
              <span className="done" />
              <span className="now" />
              <span />
            </div>
          </div>
        </Part>
      </div>

      <Part title="질문 카드">
        <div className="card">
          <div className="card-head">
            <span className="qid">Q1397</span>
            <span className="tag">[테마 시스템과 부품 갤러리]</span>
            <span className="spacer" />
            <span className="chip chip-warn">답 기다림</span>
          </div>
          <h1>기본 테마를 A3로 둘까</h1>
          <pre className="body">지금 화면이 A3입니다. 다른 테마는 설정에서 고릅니다.</pre>
          <ul className="options">
            <li>
              <button className="option picked">
                <kbd>a</kbd>
                <span>A3를 기본으로 둠</span>
                <span className="recommend">추천</span>
                <span className="quiet small num">1</span>
              </button>
            </li>
            <li>
              <button className="option">
                <kbd>b</kbd>
                <span>인광 터미널을 기본으로 둠</span>
                <span className="quiet small num">2</span>
              </button>
            </li>
            <li>
              <button className="option" disabled>
                <kbd>c</kbd>
                <span>답한 질문의 선택지(꺼짐)</span>
                <span className="quiet small num">3</span>
              </button>
            </li>
          </ul>
          <p className="reason">추천 이유: 지금 쓰는 화면이라 바뀌는 것이 없음</p>
          <textarea className="memo" placeholder="덧붙일 말 (⌘Enter 보내기, Esc 나가기)" defaultValue="" />
          <p className="error">선택지를 고르거나 메모를 적어 주세요.</p>
          <div className="actions">
            <button className="primary">(a) 보내기</button>
            <button disabled>메모만 보내기</button>
            <button>보류</button>
            <span className="spacer" />
            <span className="quiet small">
              <kbd>a</kbd> <kbd>b</kbd> <kbd>1</kbd> 고르기, <kbd>Enter</kbd> 보내기, <kbd>H</kbd> 보류
            </span>
          </div>
          <p className="answered">답: (a) A3를 기본으로 둠 (세션에 전달됨)</p>
          <h3>출처</h3>
          <ul className="small quiet source">
            <li title="세션이 ask_decision 도구로 올렸습니다">claude-ide 세션 5940c8ed에서 올린 질문</li>
          </ul>
        </div>
      </Part>

      <Part title="단계와 파이프라인">
        <ol className="stages">
          {STAGES.map((stage, i) => (
            <li key={stage} className={i < 2 ? 'done' : i === 2 ? 'now' : ''}>
              {stage}
            </li>
          ))}
        </ol>
        <ol className="pipeline">
          {STAGES.map((stage, i) => (
            <li key={stage} className={i < 2 ? 'done' : i === 2 ? 'now' : ''}>
              <span className="pipeline-name">{stage}</span>
              <span className="quiet small"> {i < 2 ? '2/2' : i === 2 ? '1/3' : '0/1'}</span>
            </li>
          ))}
        </ol>
      </Part>

      <Part title="그래프 노드(대기, 지금, 끝, 실패)">
        <Graph />
        <div className="node-detail">
          <h3>
            사용자 결정 <span className="quiet small">(확인, 사용자, 실패)</span>
          </h3>
          <div className="small mono">/Users/me/orca/workspaces/claude-ide/themes</div>
          <ul className="small check">
            <li className="bad">커밋하지 않은 변경 2개</li>
            <li className="warn">main에 아직 머지되지 않음</li>
            <li className="good">올리지 않은 커밋 0개</li>
          </ul>
        </div>
      </Part>

      <Part title="탭과 레일">
        <div className="tabbar gallery-tabs">
          <div className="tab">
            <span className="tab-title">홈</span>
          </div>
          <div className="tab on">
            <span className="tab-title">부품 갤러리</span>
            <button className="tab-close">×</button>
          </div>
          <div className="tab">
            <span className="tab-title">Q1397</span>
            <button className="tab-close">×</button>
          </div>
        </div>
        <nav className="rail gallery-rail">
          <button className="rail-button">
            <Icon name="home" />
          </button>
          <button className="rail-button on">
            <Icon name="question" />
            <span className="rail-badge">3</span>
          </button>
          <button className="rail-button">
            <Icon name="log" />
          </button>
          <button className="rail-button">
            <Icon name="settings" />
          </button>
        </nav>
      </Part>

      <Part title="입력">
        <input className="filter" placeholder="걸러 볼 말 (작업, 종류, 내용)" />
        <select className="session-select" defaultValue="a">
          <option value="a">claude-ide 세션 5940c8ed</option>
        </select>
        <Row>
          <button className="searchbox">
            <Icon name="search" size={14} /> 찾기 <kbd>⌘K</kbd>
          </button>
        </Row>
      </Part>

      <Part title="찾기 창(팔레트)">
        <div className="palette gallery-palette">
          <input className="palette-input" placeholder="작업, 질문, 화면, 할 일 찾기" />
          <div className="palette-list">
            <button className="palette-item on">
              <span className="palette-group">작업</span>
              <span>테마 시스템과 부품 갤러리</span>
              <span className="quiet small">claude-ide, 작업</span>
            </button>
            <button className="palette-item">
              <span className="palette-group">질문</span>
              <span>Q1397 기본 테마를 A3로 둘까</span>
              <span className="quiet small">답 기다림</span>
            </button>
            <button className="palette-item">
              <span className="palette-group">화면</span>
              <span>설정</span>
            </button>
          </div>
        </div>
      </Part>

      <Part title="로그 줄">
        <div className="worklog-body full">
          <LogLines events={EVENTS} />
        </div>
      </Part>

      <Part title="표">
        <table className="history">
          <thead>
            <tr>
              <th>번호</th>
              <th>작업</th>
              <th>답</th>
            </tr>
          </thead>
          <tbody>
            <tr className="clickable">
              <td>Q1396</td>
              <td>테마 시스템</td>
              <td>(a) 여덟 개로 시작</td>
            </tr>
            <tr className="clickable">
              <td>Q1395</td>
              <td>금감원 무인 자동화</td>
              <td>
                메모<div className="quiet small">재시도는 3회까지</div>
              </td>
            </tr>
          </tbody>
        </table>
      </Part>
    </div>
  )
}
