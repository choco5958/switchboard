import { describe, expect, it } from 'vitest'
import type { BridgeState } from './types'
import { hiddenProjects, isRunning, moveToFolder, restoreFolder, nameForFolder, projectFolders, sidebarGroups, pickSession, projectName, projectOfCwd, projectsOf, savedProjects, scopeFor, scopeState, shellQuote, taskState, terminalEnv } from './projects'

const state = {
  sessions: [
    { id: 's1', project: 'alpha', cwd: '/w/alpha', last_seen: 100 },
    { id: 's2', project: 'beta', cwd: '/w/beta', last_seen: 300 },
  ],
  tasks: [
    { id: 1, project: 'alpha', status: '하는 중', stage: '작업', session_id: 's1', updated_at: 50 },
    { id: 2, project: 'beta', status: '대기', stage: '설계', session_id: 's2', updated_at: 60 },
    { id: 3, project: 'gamma', status: '하는 중', stage: '작업', session_id: 's9', updated_at: 200 },
    { id: 5, project: 'alpha', status: '하는 중', stage: '완료', session_id: 's1', updated_at: 70 },
  ],
  questions: [
    { id: 10, project: 'alpha', status: 'pending' },
    { id: 11, project: 'alpha', status: 'answered' },
    { id: 12, project: 'beta', status: 'pending' },
  ],
  answeredCount: 1,
  events: [
    { id: 1, project: 'alpha' },
    { id: 2, project: 'beta' },
  ],
  nodes: [
    { id: 1, task_id: 1 },
    { id: 2, task_id: 2 },
  ],
  archived: [{ id: 4, project: 'beta' }],
  agents: [
    { id: 'a', session_id: 's1' },
    { id: 'b', session_id: 's2' },
  ],
  commands: [{ id: 1, session_id: 's2' }],
  settings: {},
} as unknown as BridgeState

describe('projects', () => {
  it('names a project after its folder', () => {
    expect(projectName('/Users/me/work/claude-ide/')).toBe('claude-ide')
  })

  it('lists projects by latest activity, with counts; a finished task is not running', () => {
    const list = projectsOf(state, [{ name: 'delta', cwd: '/w/delta' }])
    expect(list.map(p => p.name)).toEqual(['beta', 'gamma', 'alpha', 'delta'])
    expect(list.find(p => p.name === 'alpha')).toEqual({ name: 'alpha', cwd: '/w/alpha', running: 1, pending: 1, active: 100 })
    expect(list.find(p => p.name === 'gamma')?.cwd).toBe('')
  })

  it('keeps the order when a terminal saves a folder of a known project', () => {
    const before = projectsOf(state, []).map(p => p.name)
    const after = projectsOf(state, [{ name: 'alpha', cwd: '/w/alpha' }]).map(p => p.name)
    expect(after).toEqual(before)
  })

  it('labels a task in stage 완료 as finished, not running', () => {
    expect(taskState({ stage: '완료', status: '하는 중' })).toBe('done')
    expect(taskState({ stage: '작업', status: '하는 중' })).toBe('run')
    expect(taskState({ stage: '설계', status: '대기' })).toBe('wait')
    expect(isRunning({ stage: '완료', status: '하는 중' })).toBe(false)
  })

  it('matches a terminal to a project by folder, not by name', () => {
    const projects = [
      { name: 'app', cwd: '/w/one/app' },
      { name: 'two/app', cwd: '/w/two/app' },
      { name: 'w', cwd: '/w' },
    ]
    expect(projectOfCwd(projects, '/w/two/app')).toBe('two/app')
    expect(projectOfCwd(projects, '/w/one/app/src')).toBe('app')
    expect(projectOfCwd(projects, '/w/other')).toBe('w')
    expect(projectOfCwd(projects, '/w/one/application')).toBe('w')
    expect(projectOfCwd(projects, '/elsewhere')).toBeNull()
  })

  it('sends to the newest session of the project in view, never another', () => {
    const sessions = [
      { id: 'old', project: 'alpha', last_seen: 10 },
      { id: 'new', project: 'alpha', last_seen: 90 },
      { id: 'other', project: 'beta', last_seen: 99 },
    ] as BridgeState['sessions']
    expect(pickSession(sessions, 'alpha')?.id).toBe('new')
    expect(pickSession(sessions, null)?.id).toBe('other')
    expect(pickSession(sessions, 'gamma')).toBeNull()
  })

  it('moves the view to the project of an item opened from elsewhere', () => {
    expect(scopeFor('alpha', 'beta')).toBe('beta')
    expect(scopeFor('alpha', 'alpha')).toBe('alpha')
    expect(scopeFor(null, 'beta')).toBeNull()
    expect(scopeFor('alpha', undefined)).toBe('alpha')
  })

  it('takes the answered count per project from the bridge when it sends one', () => {
    const withCounts = { ...state, answeredByProject: { beta: 7 } } as BridgeState
    expect(scopeState(withCounts, 'beta').answeredCount).toBe(7)
    expect(scopeState(withCounts, 'alpha').answeredCount).toBe(0)
    expect(scopeState(state, 'alpha').answeredCount).toBe(1)
  })

  it('names a new folder without clashing with another folder of the same name', () => {
    const list = [{ name: 'web', cwd: '/a/web' }]
    expect(nameForFolder(list, '/a/web')).toBe('web')
    expect(nameForFolder(list, '/b/web')).toBe('b/web')
    expect(nameForFolder(list, '/c/api')).toBe('api')
  })

  it('keeps only well formed saved entries', () => {
    expect(savedProjects([{ name: 'a', cwd: '/a' }, { name: 1 }, null])).toEqual([{ name: 'a', cwd: '/a' }])
    expect(savedProjects('x')).toEqual([])
  })

  it('shows one project at a time, or everything for no scope', () => {
    expect(scopeState(state, null)).toBe(state)
    const beta = scopeState(state, 'beta')
    expect(beta.tasks.map(t => t.id)).toEqual([2])
    expect(beta.questions.map(q => q.id)).toEqual([12])
    expect(beta.answeredCount).toBe(0)
    expect(beta.events.map(e => e.id)).toEqual([2])
    expect(beta.nodes.map(n => n.id)).toEqual([2])
    expect(beta.archived.map(t => t.id)).toEqual([4])
    expect(beta.agents.map(a => a.id)).toEqual(['b'])
    expect(beta.commands).toHaveLength(1)
  })
})

describe('terminal environment', () => {
  it('drops the outer session and Orca variables but keeps the account folder', () => {
    const env = terminalEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      ORCA_PANE_KEY: 'y',
      CLAUDE_CONFIG_DIR: '/profile',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/profile', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'claude-ide' })
  })

  it('uses the remembered account folder when the IDE started without one', () => {
    expect(terminalEnv({ PATH: '/bin' }, '/saved').CLAUDE_CONFIG_DIR).toBe('/saved')
    expect(terminalEnv({ CLAUDE_CONFIG_DIR: '/now' }, '/saved').CLAUDE_CONFIG_DIR).toBe('/now')
  })

  // The mod in a dock terminal reads it to find the bridge this IDE talks to.
  it('passes the bridge socket through and leaves capture settings out', () => {
    const env = terminalEnv({ CLAUDE_IDE_SOCKET: '/tmp/cide/b.sock', CLAUDE_IDE_CAPTURE: '/tmp/x.png', CLAUDE_IDE_CAPTURE_JS: '1' })
    expect(env.CLAUDE_IDE_SOCKET).toBe('/tmp/cide/b.sock')
    expect(env.CLAUDE_IDE_CAPTURE).toBeUndefined()
    expect(env.CLAUDE_IDE_CAPTURE_JS).toBeUndefined()
  })

  it('quotes paths for the shell', () => {
    expect(shellQuote("/Users/me/it's here")).toBe(`'/Users/me/it'\\''s here'`)
  })
})

describe('project folders', () => {
  const info = (name: string, running = 0, pending = 0) => ({ name, cwd: `/w/${name}`, running, pending, active: 0 })
  const projects = [info('alpha', 1, 2), info('beta'), info('gamma', 2, 0), info('delta')]

  it('reads only well-formed folders and hidden names', () => {
    expect(projectFolders([{ id: 'f1', name: 'Work', projects: ['alpha', 3], closed: true }, { name: 'no id' }, null, 'x'])).toEqual([
      { id: 'f1', name: 'Work', projects: ['alpha'], closed: true },
    ])
    expect(projectFolders({})).toEqual([])
    expect(projectFolders([{ id: 'f2', name: 'Side' }])).toEqual([{ id: 'f2', name: 'Side', projects: [], closed: false }])
    expect(hiddenProjects(['alpha', 1, null])).toEqual(['alpha'])
    expect(hiddenProjects('alpha')).toEqual([])
  })

  it('groups projects into folders in list order, the rest loose', () => {
    const folders = [
      { id: 'f1', name: 'Work', projects: ['gamma', 'alpha', 'gone'], closed: false },
      { id: 'f2', name: 'Empty', projects: [], closed: true },
    ]
    const groups = sidebarGroups(projects, folders)
    expect(groups.folders.map(v => v.items.map(p => p.name))).toEqual([['alpha', 'gamma'], []])
    expect(groups.folders[0]).toMatchObject({ running: 3, pending: 2 })
    expect(groups.loose.map(p => p.name)).toEqual(['beta', 'delta'])
  })

  it('shows a project named by two folders only in the first', () => {
    const folders = [
      { id: 'f1', name: 'A', projects: ['beta'], closed: false },
      { id: 'f2', name: 'B', projects: ['beta', 'delta'], closed: false },
    ]
    expect(sidebarGroups(projects, folders).folders.map(v => v.items.map(p => p.name))).toEqual([['beta'], ['delta']])
  })

  it('moves a project between folders and out of them', () => {
    const folders = [
      { id: 'f1', name: 'A', projects: ['alpha', 'beta'], closed: false },
      { id: 'f2', name: 'B', projects: [], closed: false },
    ]
    const moved = moveToFolder(folders, 'alpha', 'f2')
    expect(moved.map(f => f.projects)).toEqual([['beta'], ['alpha']])
    expect(moveToFolder(moved, 'alpha', null).map(f => f.projects)).toEqual([['beta'], []])
    expect(moveToFolder(folders, 'beta', 'f1').map(f => f.projects)).toEqual([['alpha', 'beta'], []])
  })

  it('puts an ungrouped folder back where it was', () => {
    const work = { id: 'f1', name: 'Work', projects: ['alpha', 'beta'], closed: true }
    const side = { id: 'f2', name: 'Side', projects: ['gamma'], closed: false }
    // Ungrouped, then beta moved into Side before the undo: it goes back to Work.
    const after = [{ ...side, projects: ['gamma', 'beta'] }]
    expect(restoreFolder(after, work, 0)).toEqual([work, side])
    expect(restoreFolder([side], work, 5).map(f => f.id)).toEqual(['f2', 'f1'])
    // Already back: nothing changes.
    expect(restoreFolder([work, side], work, 1)).toEqual([work, side])
  })
})
