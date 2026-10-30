import { useRef, useState, type ReactNode } from 'react'
import type { Approval, LogEvent, Question, Task } from '../../../shared/types'
import { Icon, ICON_PX, type IconName } from '../Icons'
import { ApprovalItem, LogLines, NumberBadge, QueueItem, TaskItem, Toast } from '../parts'
import {
  Badge,
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  Select,
  TabList,
  TextArea,
  surfaceClass,
  type BadgeFill,
  type BadgeShape,
  type ButtonVariant,
  type Tone,
} from '../ui'

// The catalog of the design system: every token, every shared part (ui.tsx) in each variant and
// state, and the screen parts built from them, with static sample data. Switch the theme and
// look here first; it doubles as the visual regression check (a capture per theme). Nothing here
// calls the bridge; buttons do nothing, except the ones that open a menu or a dialog.

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

const APPROVAL: Approval = {
  id: 12,
  session_id: 'sample',
  project: 'claude-ide',
  tool: 'Bash',
  summary: 'pnpm build && pnpm test',
  cwd: '/Users/me/projects/claude-ide',
  reason: '빌드와 시험',
  status: 'pending',
  via: 'mod',
  created_at: NOW - 60_000,
  answered_at: null,
}

const EVENTS: LogEvent[] = [
  { id: 1, ts: NOW - 300_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '작업', text: '테마 파일 여덟 개를 만듦' },
  { id: 2, ts: NOW - 240_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '결정 대기', text: 'Q1397 기본 테마를 A3로 둘까' },
  { id: 3, ts: NOW - 180_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '답함', text: 'Q1397 (a) A3 기본' },
  { id: 4, ts: NOW - 120_000, session_id: 'sample', project: 'claude-ide', task_title: '테마 시스템', kind: '전달', text: '세션에 답을 넣음' },
]

const STAGES = ['요구', '설계', '작업', '완료']
const COLOR_TOKENS = ['bg', 'panel', 'panel-2', 'line', 'line-strong', 'text', 'quiet', 'accent', 'accent-soft', 'on-accent', 'good', 'warn', 'bad', 'on-good', 'on-warn', 'focus']
const TASK_TOKENS = ['task-0', 'task-1', 'task-2', 'task-3', 'task-4', 'task-5']
const TYPE = [
  ['--fs-xs', '배지, kbd, 상태'],
  ['--fs-sm', '보조 글, 로그'],
  ['--fs-md', '본문'],
  ['--fs-lg', '판 제목, 찾기 입력'],
  ['--fs-xl', '카드 제목'],
  ['--fs-stat', '홈 숫자'],
]
const SPACE = ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6']
const RADII = ['--r-sm', '--r-md', '--r-lg', '--r-pill']
const SHADOWS = ['--shadow-pop', '--shadow-modal', '--shadow-surface']
const TONES: Tone[] = ['neutral', 'accent', 'good', 'warn', 'bad']
const VARIANTS: ButtonVariant[] = ['default', 'primary', 'danger', 'ghost', 'link']
const ICONS: IconName[] = ['home', 'question', 'debug', 'archive', 'history', 'log', 'linear', 'gallery', 'settings', 'search', 'folder', 'more', 'sidebar', 'dock', 'sun', 'moon', 'close', 'check', 'play', 'collapse', 'expand', 'chevronDown', 'chevronUp', 'panelOpen', 'panelClose']

function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="gallery-part">
      <h2>{title}</h2>
      {note && <p className="quiet small">{note}</p>}
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

function Tokens() {
  return (
    <Part title="토큰" note="색은 테마마다(themes/*.css), 나머지는 styles.css의 :root에 있습니다. 이름은 DESIGN_SYSTEM.md의 표와 같습니다.">
      <h3>색</h3>
      <div className="gallery-tokens">
        {[...COLOR_TOKENS, ...TASK_TOKENS].map(name => (
          <span key={name} className="gallery-token">
            <i style={{ background: `var(--${name})` }} />
            <span className="mono-inline">--{name}</span>
          </span>
        ))}
      </div>
      <h3>글자 크기</h3>
      {TYPE.map(([name, use]) => (
        <div key={name} style={{ fontSize: `var(${name})`, lineHeight: 'var(--lh-tight)', margin: 'var(--sp-1) 0' }}>
          {name} <span className="quiet">{use}</span>
        </div>
      ))}
      <h3>간격, 모서리, 그림자</h3>
      <Row>
        {SPACE.map(name => (
          <span key={name} className="gallery-token">
            <i style={{ width: `var(${name})`, height: 'var(--sp-4)', background: 'var(--accent)' }} />
            <span className="mono-inline">{name}</span>
          </span>
        ))}
      </Row>
      <Row>
        {RADII.map(name => (
          <span key={name} className="gallery-token">
            <i style={{ width: 56, borderRadius: `var(${name})`, background: 'var(--panel-2)', borderColor: 'var(--line-strong)' }} />
            <span className="mono-inline">{name}</span>
          </span>
        ))}
        {SHADOWS.map(name => (
          <span key={name} className="gallery-token">
            <i style={{ width: 96, background: 'var(--panel)', boxShadow: `var(${name})` }} />
            <span className="mono-inline">{name}</span>
          </span>
        ))}
      </Row>
    </Part>
  )
}

function Buttons() {
  return (
    <Part title="버튼 (Button)" note="기본, 주 버튼, 위험, 고스트, 링크. 각각 보통과 작은 크기, 꺼진 상태. Tab으로 옮겨 다니면 초점 고리가 보입니다.">
      {(['md', 'sm'] as const).map(size => (
        <Row key={size}>
          {VARIANTS.map(variant => (
            <Button key={variant} variant={variant} size={size}>
              {variant}
            </Button>
          ))}
          {VARIANTS.map(variant => (
            <Button key={`${variant}-off`} variant={variant} size={size} disabled>
              {variant} 꺼짐
            </Button>
          ))}
        </Row>
      ))}
      <h3>아이콘 버튼 (IconButton)</h3>
      <Row>
        {(['sm', 'md', 'lg'] as const).map(size => (
          <IconButton key={size} icon="settings" size={size} label={`크기 ${size}`} />
        ))}
        <IconButton icon="question" size="lg" label="현재 위치" on badge={<Badge shape="count" tone="warn">3</Badge>} />
        <IconButton icon="close" size="sm" label="닫기" />
        <IconButton icon="close" size="sm" label="닫기" disabled />
        <IconButton icon="close" size="sm" label="두 번 눌러 닫기" className="tab-close">
          닫기?
        </IconButton>
      </Row>
      <h3>아이콘 (sm {ICON_PX.sm}, md {ICON_PX.md}, lg {ICON_PX.lg})</h3>
      <Row>
        {ICONS.map(name => (
          <span key={name} className="gallery-token" title={name}>
            <Icon name={name} size="lg" />
            <span className="mono-inline">{name}</span>
          </span>
        ))}
      </Row>
    </Part>
  )
}

function Badges() {
  const looks: [BadgeShape, BadgeFill][] = [
    ['box', 'outline'],
    ['box', 'soft'],
    ['pill', 'outline'],
    ['pill', 'soft'],
  ]
  return (
    <Part title="배지와 칩 (Badge, Chip)" note="색은 다섯 가지(neutral, accent, good, warn, bad). 꽉 찬 바탕은 accent, good, warn만 씁니다.">
      {looks.map(([shape, fill]) => (
        <Row key={`${shape}-${fill}`}>
          <span className="quiet small mono-inline">
            {shape} {fill}
          </span>
          {TONES.map(tone => (
            <Badge key={tone} shape={shape} fill={fill} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Row>
      ))}
      <Row>
        <span className="quiet small mono-inline">solid, count</span>
        <Badge fill="solid" tone="good" className="recommend">
          추천
        </Badge>
        <Badge fill="solid" tone="warn">
          결정
        </Badge>
        <Badge shape="count" tone="warn">
          3
        </Badge>
        <Badge shape="count" tone="accent">
          12
        </Badge>
        {[1, 2, 3, 4, 5, 6].map(number => (
          <NumberBadge key={number} task={{ number }} />
        ))}
        <Badge mono tone="good">
          1년
        </Badge>
        <Badge mono tone="bad">
          D-2
        </Badge>
      </Row>
      <Row>
        <span className="quiet small mono-inline">Chip</span>
        <Chip>진행 보고</Chip>
        <Chip tone="warn">결정 3</Chip>
        <Chip tone="good">● 실시간</Chip>
        <Chip tone="bad">끊김</Chip>
        <Chip on>고른 필터</Chip>
        <Chip disabled>꺼짐</Chip>
      </Row>
    </Part>
  )
}

function Fields() {
  return (
    <Part title="입력 (Input, TextArea, Select)" note="모든 입력칸이 한 모양입니다. 자리 표시 글만 있는 칸도 aria-label로 이름을 붙입니다.">
      <div className="agent-form">
        <label>
          <span className="small">보통</span>
          <Input placeholder="걸러 볼 말 (작업, 종류, 내용)" />
        </label>
        <label>
          <span className="small">작은 크기, 고정폭</span>
          <Input compact mono defaultValue="http://localhost:5173/" />
        </label>
        <label>
          <span className="small">꺼짐</span>
          <Input disabled defaultValue="바꿀 수 없음" />
        </label>
        <label>
          <span className="small">여러 줄</span>
          <TextArea placeholder="덧붙일 말 (⌘Enter 보내기, Esc 나가기)" />
        </label>
        <Row>
          <Select defaultValue="a" aria-label="세션">
            <option value="a">claude-ide 세션 5940c8ed</option>
          </Select>
          <Select compact defaultValue="a" aria-label="작은 고르기">
            <option value="a">작은 고르기</option>
          </Select>
          <label className="check-row">
            <input type="checkbox" defaultChecked /> 체크 상자
          </label>
          <button type="button" className="btn btn-sm switch switch-on" role="switch" aria-checked="true">
            <span className="switch-track">
              <span className="switch-knob" />
            </span>
            스위치
          </button>
          <button type="button" className="searchbox">
            <Icon name="search" size="sm" /> 찾기 <kbd>⌘K</kbd>
          </button>
        </Row>
      </div>
    </Part>
  )
}

function Surfaces() {
  return (
    <Part title="표면과 행 (Card, row)" note="선택된 것은 옅은 강조 바탕과 왼쪽 막대로 표시합니다. 카드, 행, 표 줄이 모두 같습니다.">
      <div className="gallery-grid">
        <Card pad="sm">pad sm</Card>
        <Card>pad md</Card>
        <Card sunk>sunk, 판 안의 한 단계 깊은 바탕</Card>
        <button type="button" className={surfaceClass({ interactive: true })}>
          interactive, 올리면 테두리가 짙어짐
        </button>
        <Card on>on, 선택됨</Card>
        <Card tone="warn">tone warn, 기다리는 요청</Card>
      </div>
      <div className="gallery-pane" style={{ marginTop: 'var(--sp-3)' }}>
        <button type="button" className="row">
          행
        </button>
        <button type="button" className="row on">
          고른 행 <span className="quiet small">흐린 글자도 읽힘</span>
        </button>
        <button type="button" className="row">
          다른 행
        </button>
      </div>
    </Part>
  )
}

function Overlays() {
  const [menu, setMenu] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [tab, setTab] = useState('b')
  const menuBox = useRef<HTMLSpanElement>(null)
  return (
    <Part title="메뉴, 탭, 대화상자 (Menu, TabList, Dialog)" note="메뉴와 대화상자는 눌러서 엽니다. 화살표, Home, End, Esc가 동작하고 닫으면 초점이 돌아옵니다.">
      <Row>
        <span className="gallery-menu" ref={menuBox}>
          <Button aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
            메뉴 열기
          </Button>
          {menu && (
            <Menu label="견본 메뉴" className="row-menu" onClose={() => setMenu(false)} within={menuBox}>
              <MenuItem icon="folder" onSelect={noop}>
                폴더로 옮기기
              </MenuItem>
              <MenuItem onSelect={noop}>이름 바꾸기</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={noop}>목록에서 빼기</MenuItem>
            </Menu>
          )}
        </span>
        <Button onClick={() => setDialog(true)}>대화상자 열기</Button>
      </Row>
      <div className="tabbar gallery-tabs">
        <TabList
          label="견본 탭"
          active={tab}
          onSelect={setTab}
          items={[
            { key: 'a', label: <><Icon name="home" size="sm" /><span className="tab-title">홈</span></> },
            { key: 'b', label: <span className="tab-title">부품 갤러리</span>, close: { label: '부품 갤러리 탭 닫기', onClose: noop } },
            { key: 'c', label: <><NumberBadge task={TASK} /><span className="tab-title">{TASK.title}</span></>, close: { label: '닫기', onClose: noop } },
          ]}
        />
      </div>
      <div className="dock-head gallery-tabs">
        <TabList
          label="견본 도크 탭"
          className="dock-tabs"
          active="log"
          onSelect={noop}
          items={[
            { key: 'log', label: '작업 로그' },
            { key: 't1', label: 'claude-ide', close: { label: '터미널 닫기', onClose: noop } },
            { key: 't2', label: 'shell', close: { label: '터미널 닫기', onClose: noop, content: '닫기?', className: 'armed' } },
          ]}
        />
      </div>
      <nav className="rail gallery-rail">
        <IconButton icon="home" size="lg" label="홈" />
        <IconButton icon="question" size="lg" label="결정" on badge={<Badge shape="count" tone="warn">3</Badge>} />
        <IconButton icon="log" size="lg" label="로그" />
      </nav>
      {dialog && (
        <Dialog label="견본 대화상자" onClose={() => setDialog(false)} className="transcript">
          <div className="card-head">
            <b>견본 대화상자</b>
            <span className="spacer" />
            <Button variant="link" onClick={() => setDialog(false)}>
              닫기
            </Button>
          </div>
          <p>Tab은 안에서만 돌고, Esc나 바깥을 누르면 닫힙니다.</p>
          <div className="actions">
            <Button variant="primary">확인</Button>
            <Button>취소</Button>
          </div>
        </Dialog>
      )}
      <h3>찾기 창 모양</h3>
      <div className="dialog palette" style={{ width: '100%', maxWidth: 640 }}>
        <input className="palette-input" aria-label="찾기" placeholder="작업, 질문, 화면, 할 일 찾기" />
        <div className="palette-list" role="listbox" aria-label="찾기">
          <div role="option" aria-selected="true" className="row palette-item on">
            <span className="palette-group">작업</span>
            <span className="palette-label">테마 시스템과 부품 갤러리</span>
            <span className="quiet small palette-hint">claude-ide, 작업</span>
          </div>
          <div role="option" aria-selected="false" className="row palette-item">
            <span className="palette-group">질문</span>
            <span className="palette-label">Q1397 기본 테마를 A3로 둘까</span>
            <span className="quiet small palette-hint">답 기다림</span>
          </div>
          <div role="option" aria-selected="false" aria-disabled="true" className="row palette-item disabled">
            <span className="palette-group">할 일</span>
            <span className="palette-label">끝난 것 모두 보관</span>
            <span className="quiet small palette-hint">끝난 작업이 없습니다</span>
          </div>
        </div>
      </div>
    </Part>
  )
}

function Feedback() {
  return (
    <Part title="알림, 빈 상태, 토스트, 미터">
      <Notice tone="error" title="연결이 끊겼습니다">
        <span className="small">화면은 마지막으로 받은 내용입니다.</span>
      </Notice>
      <Notice tone="warn">
        <span className="small">실시간 갱신을 멈췄습니다.</span>
      </Notice>
      <Notice tone="info">
        <span className="small">알림: 정보는 강조색 막대로 보입니다.</span>
      </Notice>
      <EmptyState title="아직 작업이 없습니다" action={<Button size="sm">폴더 고르기</Button>}>
        세션이 작업을 올리면 여기에 나타납니다.
      </EmptyState>
      <EmptyState>제목 없는 빈 상태: 한 줄 안내만 둡니다.</EmptyState>
      <div style={{ position: 'relative', height: 200 }}>
        <Toast
          toasts={[
            { id: 1, text: '진행 보고를 요청했습니다.', kind: 'good' },
            { id: 2, text: '프로젝트를 목록에서 뺐습니다.', kind: 'info', action: { label: '되돌리기', run: noop } },
            { id: 3, text: '보내지 못했습니다.', kind: 'bad' },
          ]}
          onDismiss={noop}
        />
      </div>
      <Row>
        <Meter label="5시간" percent={39} level="good" />
        <Meter label="주간" percent={81} level="warn" />
        <Meter label="컨텍스트" percent={94} level="bad" />
      </Row>
    </Part>
  )
}

export function GalleryPage() {
  return (
    <div className="card wide gallery">
      <h1>부품 갤러리</h1>
      <p className="quiet small">디자인 시스템의 토큰과 공용 부품을 모든 변형과 상태로 모았습니다. 테마를 바꾼 뒤 여기서 한눈에 확인합니다. 견본 데이터라 눌러도 아무 일이 일어나지 않습니다.</p>

      <Tokens />
      <Buttons />
      <Badges />
      <Fields />
      <Surfaces />
      <Overlays />
      <Feedback />

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

      <div className="gallery-grid">
        <Part title="작업 목록 항목">
          <div className="gallery-pane">
            <TaskItem task={TASK} active openQuestions={2} nodeCount={4} onClick={noop} />
            <TaskItem task={WAITING} active={false} openQuestions={0} nodeCount={0} attention="stalled" onClick={noop} />
          </div>
        </Part>
        <Part title="결정 대기 항목">
          <div className="gallery-pane">
            <QueueItem q={QUESTION} active onClick={noop} />
            <QueueItem q={{ ...QUESTION, id: 1398, task_title: '금감원 무인 자동화', question: '재시도 상한을 3회로 할까' }} active={false} gone onClick={noop} />
          </div>
        </Part>
        <Part title="홈 카드와 통계">
          <div className={surfaceClass({}, 'stat')}>
            <b>3</b>
            <span>진행 중 작업</span>
          </div>
          <button type="button" className={surfaceClass({}, 'home-card')}>
            <div className="task-title">
              <NumberBadge task={TASK} /> {TASK.title}
            </div>
            <div className="quiet small">claude-ide, 작업, 노드 2/4, 2분 전</div>
            <div className="mini-stages" aria-hidden="true">
              <span className="done" />
              <span className="done" />
              <span className="now" />
              <span />
            </div>
          </button>
        </Part>
        <Part title="권한 요청">
          <ApprovalItem a={APPROVAL} onAnswer={noop} />
        </Part>
      </div>

      <Part title="결정 카드">
        <div className="card">
          <div className="card-head">
            <span className="qid">Q1397</span>
            <span className="tag">[테마 시스템과 부품 갤러리]</span>
            <span className="spacer" />
            <Badge shape="pill" tone="warn">
              답 기다림
            </Badge>
          </div>
          <h1>기본 테마를 A3로 둘까</h1>
          <pre className="body">지금 화면이 A3입니다. 다른 테마는 설정에서 고릅니다.</pre>
          <ul className="options">
            <li>
              <button type="button" className={surfaceClass({ on: true }, 'option')} aria-pressed="true">
                <kbd>a</kbd>
                <span>A3를 기본으로 둠</span>
                <Badge tone="good" fill="solid" className="recommend">
                  추천
                </Badge>
                <span className="quiet small num">1</span>
              </button>
            </li>
            <li>
              <button type="button" className={surfaceClass({}, 'option')} aria-pressed="false">
                <kbd>b</kbd>
                <span>인광 터미널을 기본으로 둠</span>
                <span className="quiet small num">2</span>
              </button>
            </li>
            <li>
              <button type="button" className={surfaceClass({}, 'option')} disabled>
                <kbd>c</kbd>
                <span>답한 질문의 선택지(꺼짐)</span>
                <span className="quiet small num">3</span>
              </button>
            </li>
          </ul>
          <TextArea aria-label="덧붙일 메모" placeholder="덧붙일 말 (⌘Enter 보내기, Esc 나가기)" />
          <Notice tone="error" className="mt-sm">
            선택지를 고르거나 메모를 적어 주세요.
          </Notice>
          <div className="actions">
            <Button variant="primary">(a) 보내기</Button>
            <Button disabled>메모만 보내기</Button>
            <Button>보류</Button>
          </div>
        </div>
      </Part>

      <Part title="단계와 파이프라인" note="끝난 단계는 색과 함께 체크 표시, 작은 단계 줄은 끝남이 꽉 찬 막대, 지금이 빗금, 남은 것은 테두리만입니다.">
        <ol className="stages">
          {STAGES.map((stage, i) => (
            <li key={stage} className={i < 2 ? 'done' : i === 2 ? 'now' : ''}>
              {i < 2 && <Icon name="check" size="sm" />}
              {stage}
            </li>
          ))}
        </ol>
        <ol className="pipeline">
          {STAGES.map((stage, i) => (
            <li key={stage} className={i < 2 ? 'done' : i === 2 ? 'now' : ''}>
              <span className="stage-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="pipeline-name">{stage}</span>
              {i < 2 && (
                <span className="stage-done">
                  <Icon name="check" size="sm" />
                </span>
              )}
            </li>
          ))}
        </ol>
      </Part>

      <Part title="로그 줄">
        <div className="worklog-body full">
          <LogLines events={EVENTS} />
        </div>
      </Part>

      <Part title="표">
        <table className="history node-table">
          <thead>
            <tr>
              <th>번호</th>
              <th>작업</th>
              <th>답</th>
            </tr>
          </thead>
          <tbody>
            <tr className="clickable on" tabIndex={0}>
              <td>Q1396</td>
              <td>테마 시스템 (고른 줄)</td>
              <td>(a) 여덟 개로 시작</td>
            </tr>
            <tr className="clickable" tabIndex={0}>
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
