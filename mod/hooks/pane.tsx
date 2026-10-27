import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, On, Timer } from 'claude-code'

import type { FlowAgent, FlowNode, FlowTask, PaneView, RefreshReason, Snapshot } from '../types'
import { currentLang, sessionLang, setLang, t, taskStatusLabel, type Key, type Lang } from './i18n.ts'
import {
  ARROW_CELLS,
  agentLine,
  agentRows,
  agentStatusText,
  agentTitle,
  agentsOf,
  bandText,
  costText,
  countChips,
  countsOf,
  graphLayout,
  isAgentDone,
  isHandoff,
  legend,
  nodeBox,
  nodeTone,
  nodesOf,
  paneAction,
  parseState,
  progressText,
  questionLine,
  recommendLine,
  refreshText,
  splitRow,
  summaryLines,
  taskHead,
  taskMeta,
  transcriptLines,
  truncate,
} from './flow'

// The Switchboard pane beside the transcript: this session's tasks and their
// nodes, and the questions waiting for a decision, read from the bridge's
// /state every few seconds while the pane is placed, at each turn's start and
// end, and on the r key. The band above the prompt draws from the same read.

export const PANE = 'claude-ide'
const TITLE = 'Switchboard'
const POLL_MS = 3000
// The pane opens from /switchboard: /ide is a command Claude Code ships, and
// $.command.register refuses that name.

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const feed = atom(
  { plugin: 'ide-bridge', key: 'feed' } as const,
  { snapshot: null, checkedAt: 0, isOffline: false, reason: '' },
  { shape: 'feed-3' },
)
const view = atom(
  { plugin: 'ide-bridge', key: 'view' } as const,
  { tab: 'flow', isSummaryOpen: false, openAgents: [] },
  { shape: 'view-2' },
)
const turn = atom({ plugin: 'ide-bridge', key: 'turn' } as const, { isBusy: false, since: 0 })
const transcript = atom({ plugin: 'ide-bridge', key: 'transcript' } as const, null)

const REASONS: Record<RefreshReason, Key | undefined> = {
  '': undefined,
  auto: 'reason.auto',
  open: 'reason.open',
  key: 'reason.key',
  turnStart: 'reason.turnStart',
  turnEnd: 'reason.turnEnd',
  agentTurnEnd: 'reason.agentTurnEnd',
}

let home = ''
let sessionId = ''
let socket = ''
let timer: Timer | undefined
let isPolling = false
// A refresh asked for while another runs: it runs once that one ends.
let queued: RefreshReason | undefined

async function isPlaced($: Engine): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

async function costOf($: Engine): Promise<number | null> {
  try {
    const usage = await $.session.usage()
    return usage.cost?.usd ?? null
  } catch {
    return null
  }
}

async function envOf($: Engine): Promise<string | undefined> {
  try {
    return await $.env.get('CLAUDE_IDE_SOCKET')
  } catch {
    return undefined
  }
}

// The bridge's socket: CLAUDE_IDE_SOCKET when set, as the bridge itself reads it.
async function socketPath($: Engine): Promise<string> {
  if (socket) return socket
  if (!home) home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  socket = (await envOf($)) || `${home}/.claude-ide/bridge.sock`
  return socket
}

async function fetchSnapshot($: Engine): Promise<Snapshot> {
  if (!sessionId) sessionId = await $.session.id()
  const res = await $.http.fetch('http://bridge/state', { socketPath: await socketPath($) })
  if (!res.ok) throw new Error(`bridge answered ${res.status}`)
  const snapshot = parseState(JSON.parse(res.text) as unknown, sessionId, await $.clock.now())
  const cost = await costOf($)
  return cost === null ? snapshot : { ...snapshot, costUsd: cost }
}

// One fetch, `reason` saying what asked for it. The poll fetches nothing
// while the pane waits undrawn; a turn or the r key fetches anyway, so the
// band above the prompt stays current. On a failure the last good snapshot
// stays and the pane says the bridge is not reached.
async function refresh($: Engine, reason: RefreshReason, isPoll = false): Promise<void> {
  if (isPolling) {
    if (!isPoll) queued = reason
    return
  }
  isPolling = true
  try {
    if (isPoll && !(await isPlaced($))) return
    try {
      const snapshot = await fetchSnapshot($)
      setLang(snapshot.lang)
      await update($, feed, () => ({ snapshot, checkedAt: snapshot.fetchedAt, isOffline: false, reason }))
    } catch {
      const checkedAt = await $.clock.now()
      await update($, feed, last => ({ ...last, checkedAt, isOffline: true, reason }))
    }
  } finally {
    isPolling = false
  }
  const again = queued
  queued = undefined
  if (again !== undefined) await refresh($, again)
}

function startPolling($: Engine): void {
  if (timer !== undefined) return
  timer = $.clock.every(POLL_MS, () => void refresh($, 'auto', true))
  void refresh($, 'open', true)
}

function stopPolling(): void {
  timer?.cancel()
  timer = undefined
}

async function openPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  startPolling($)
  return opened.isPlaced
}

async function openFromCommand($: Engine): Promise<string> {
  const isShown = await openPane($)
  return t(currentLang(), isShown ? 'cmd.opened' : 'cmd.notPlaced')
}

async function registerCommands($: Engine): Promise<void> {
  await $.command
    .register({ name: 'switchboard', description: t(await sessionLang($), 'cmd.description') })
    .catch(() => undefined)
}

// A prompt to Claude and a toast that says so, in the pane's language.
async function ask($: Engine, lang: Lang, text: Key, toast: Key): Promise<void> {
  try {
    await $.prompt.submit({ text: t(lang, text) })
    $.ui.toast(t(lang, toast))
  } catch {
    $.ui.toast(t(lang, 'cmd.askFailed'))
  }
}

async function toggleAgents($: Engine, taskId: number): Promise<void> {
  await update($, view, (v): PaneView => ({
    ...v,
    openAgents: v.openAgents.includes(taskId) ? v.openAgents.filter(id => id !== taskId) : [...v.openAgents, taskId],
  }))
}

// A subagent's recent steps shown under its row; pressed again, they close.
async function openTranscript($: Engine, agentId: string): Promise<void> {
  const shown = await read($, transcript)
  if (shown?.agentId === agentId) {
    await update($, transcript, () => null)
    return
  }
  const found = await $.session.messages({ agentId }).catch((error: unknown) => ({ deny: String(error) }))
  const opened =
    'deny' in found
      ? { agentId, lines: [], note: String(found.deny) }
      : { agentId, lines: transcriptLines(found, 12, currentLang()), note: '' }
  await update($, transcript, () => opened)
}

async function markTurn($: Engine, isBusy: boolean): Promise<void> {
  const since = await $.clock.now()
  await update($, turn, () => ({ isBusy, since }))
}

export function registerPane(on: On): void {
  // Only a session with a person at the prompt draws the pane.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await markTurn($, false)
    await registerCommands($)
    void openPane($).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'switchboard' }, async ($, e) => {
    const action = paneAction(e.args)
    const lang = currentLang()
    if (action === 'report') {
      await ask($, lang, 'pane.reportPrompt', 'cmd.reportToast')
      return { text: t(lang, 'cmd.reportDone') }
    }
    if (action === 'sync') {
      await ask($, lang, 'pane.syncPrompt', 'cmd.syncToast')
      return { text: t(lang, 'cmd.syncDone') }
    }
    if (action === 'summary') {
      await update($, view, (v): PaneView => ({ ...v, tab: 'flow', isSummaryOpen: true }))
      return { text: await openFromCommand($) }
    }
    if (action === 'unknown') return { text: t(lang, 'cmd.usage') }
    return { text: await openFromCommand($) }
  })

  // The poll stops with the pane; a hook above that keeps it open keeps it.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE)) stopPolling()
    return closed
  }).catch(($, e, next) => next(e))

  // A turn's start and end refresh at once, and the main loop's turn tells
  // finished subagents still waiting on Claude from those it has taken up.
  // The matcher takes every turn: register.ts hooks these events too, and a
  // module may hook an event once without a matcher.
  const everyTurn = { turnId: /./ }
  on('turn.start', everyTurn, async ($, e, next) => {
    if (e.agentId === undefined) {
      await markTurn($, true)
      void refresh($, 'turnStart')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', everyTurn, async ($, e, next) => {
    if (e.agentId === undefined) await markTurn($, false)
    void refresh($, e.agentId === undefined ? 'turnEnd' : 'agentTurnEnd')
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band above the prompt: how many subagents run, what each running
  // task does now, and how many questions wait for the person, from the
  // pane's last snapshot. The engine's [-] beside it folds it away.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { snapshot, isOffline } = await read($, feed)
    // Old numbers from a bridge no longer reached would read as current.
    const line = snapshot && !isOffline ? bandText(snapshot, Math.max(10, e.props.bodyColumns), snapshot.lang) : ''
    if (!line) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text color="warning" wrap="truncate-end">
        {line}
      </Text>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    // One round trip for all of them: a busy engine answers each call late, and
    // five in a row once ran the drawing past its 10s budget.
    const [{ snapshot, isOffline, reason }, { tab, isSummaryOpen, openAgents }, mainTurn, shown, now] = await Promise.all([
      read($, feed),
      read($, view),
      read($, turn),
      read($, transcript),
      $.clock.now(),
    ])

    // A language change shows on the next refresh; before the first one, the last language known.
    const lang = snapshot?.lang ?? currentLang()
    const [title, cost] = splitRow(TITLE, costText(snapshot?.costUsd ?? null, lang), width - 8)
    const why = REASONS[reason] ? t(lang, REASONS[reason]) : ''
    const age = snapshot ? refreshText(now - snapshot.fetchedAt, why, lang) : ''
    const offline = t(lang, 'pane.offline')
    const status = isOffline ? [offline, age].filter(Boolean).join(t(lang, 'sep')) : age || t(lang, 'pane.loading')
    const tasks = snapshot?.tasks ?? []
    const questions = snapshot?.questions ?? []

    // Columns of bordered boxes, arrows between them; a plan wider than the
    // pane goes on in a band below.
    const graph = (nodes: FlowNode[], inner: number): JSX.Element[] => {
      const { boxCells, bands } = graphLayout(nodes, inner)
      return bands.map((band, b) => (
        <Box flexDirection="row" marginTop={b > 0 ? 1 : 0}>
          {band.flatMap((column, c) => [
            ...(c > 0
              ? [
                  <Box flexDirection="column" justifyContent="center" width={ARROW_CELLS}>
                    <Text dimColor> → </Text>
                  </Box>,
                ]
              : []),
            <Box flexDirection="column" width={boxCells}>
              {column.map(node => {
                const tone = nodeTone(node, nodes)
                const [head, foot] = nodeBox(node, nodes, boxCells - 2, lang)
                return (
                  <Box
                    flexDirection="column"
                    width={boxCells}
                    borderStyle={tone.borderStyle}
                    borderColor={tone.color}
                    borderDimColor={tone.isDim}
                  >
                    <Text color={tone.isDim ? undefined : tone.color} dimColor={tone.isDim} wrap="truncate-end">
                      {head}
                    </Text>
                    <Text dimColor wrap="truncate-end">
                      {foot}
                    </Text>
                  </Box>
                )
              })}
            </Box>,
          ])}
        </Box>
      ))
    }

    const transcriptRows = (inner: number): JSX.Element => (
      <Box flexDirection="column" paddingLeft={2}>
        {shown?.note ? (
          <Text color="warning">{truncate(t(lang, 'pane.transcriptError', { error: shown.note }), inner - 2)}</Text>
        ) : null}
        {shown && !shown.note && shown.lines.length === 0 ? <Text dimColor>{t(lang, 'pane.noTranscript')}</Text> : null}
        {(shown?.lines ?? []).map(line => (
          <Text dimColor wrap="truncate-end">
            {truncate(line, inner - 2)}
          </Text>
        ))}
        <Button key="transcript-close" plain label={t(lang, 'pane.closeTranscript')} onPress={() => update($, transcript, () => null)} />
      </Box>
    )

    const agentSection = (task: FlowTask, agents: FlowAgent[], inner: number): JSX.Element[] => {
      if (agents.length === 0) return []
      const isOpen = openAgents.includes(task.id)
      const rows = agentRows(agents, isOpen)
      const out = [
        <Button
          key={`agents-${task.id}`}
          plain
          label={truncate(agentLine(agents, isOpen, lang), inner)}
          onPress={() => toggleAgents($, task.id)}
        />,
      ]
      if (isHandoff(agents, mainTurn)) out.push(<Text color="claude">{truncate(`● ${t(lang, 'flow.handoff')}`, inner)}</Text>)
      for (const agent of rows) {
        const said = agentStatusText(agent.status, lang)
        const isDone = isAgentDone(agent)
        const [left] = splitRow(`${isDone ? '○' : '●'} ${agentTitle(agent.description)}`, said, inner - 5)
        out.push(
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor={isDone} wrap="truncate-end">
              {left}
            </Text>
            <Box flexDirection="row" columnGap={1}>
              <Text color={agent.status === 'failed' ? 'error' : isDone ? undefined : 'warning'} dimColor={isDone}>
                {said}
              </Text>
              <Button key={`open-${agent.id}`} plain label={t(lang, 'pane.open')} onPress={() => openTranscript($, agent.id)} />
            </Box>
          </Box>,
        )
        if (shown?.agentId === agent.id) out.push(transcriptRows(inner))
      }
      if (isOpen && agents.length > rows.length) out.push(<Text dimColor>{t(lang, 'pane.more', { n: agents.length - rows.length })}</Text>)
      return out
    }

    const flowRows = (): JSX.Element[] => {
      if (!snapshot) return []
      const out = [<Text wrap="truncate-end">{truncate(`${t(lang, 'pane.flowHead')}  ${legend(lang)}`, width)}</Text>]
      if (tasks.length === 0) return [...out, <Text dimColor>{t(lang, 'pane.noTasks')}</Text>]
      const inner = width - 2
      for (const task of tasks) {
        const nodes = nodesOf(snapshot, task)
        const agents = agentsOf(snapshot, task)
        const runs = agents.some(a => a.status === 'running') ? t(lang, 'pane.running') : ''
        const right = [nodes.length > 0 ? progressText(nodes) : '', taskStatusLabel(lang, task.status)].filter(Boolean).join('  ')
        const [head, tail] = splitRow(taskHead(task), right, width)
        const meta = taskMeta(task, nodes, lang)
        out.push(
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="bold">{head}</Text>
              <Text>{tail}</Text>
            </Box>
            {meta ? <Text dimColor>{truncate(meta, width)}</Text> : null}
            <Box flexDirection="column" paddingLeft={2}>
              {graph(nodes, inner)}
              {task.now || runs ? (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>{splitRow(task.now, runs, inner)[0]}</Text>
                  {runs ? <Text color="success">{runs}</Text> : null}
                </Box>
              ) : null}
              {agentSection(task, agents, inner)}
            </Box>
          </Box>,
        )
      }
      return out
    }

    const decisionRows = (): JSX.Element[] =>
      questions.length === 0
        ? [<Text dimColor>{t(lang, 'pane.noQuestions')}</Text>]
        : questions.map(q => (
            <Box flexDirection="column">
              <Text wrap="truncate-end">{truncate(questionLine(q), width)}</Text>
              {recommendLine(q) ? (
                <Box paddingLeft={2}>
                  <Text color="suggestion" wrap="truncate-end">
                    {truncate(recommendLine(q), width - 2)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold">{title}</Text>
          <Box flexDirection="row" columnGap={1}>
            {cost ? <Text>{cost}</Text> : null}
            <Button key="refresh" hotkey="r" plain label={t(lang, 'pane.refresh')} onPress={() => refresh($, 'key')} />
          </Box>
        </Box>
        <Text dimColor={!isOffline} color={isOffline ? 'warning' : undefined} wrap="truncate-end">
          {truncate(status, width)}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="tab-flow"
            hotkey="1"
            label={t(lang, 'pane.tabFlow', { n: tasks.length })}
            variant={tab === 'flow' ? 'primary' : 'secondary'}
            onPress={() => update($, view, (v): PaneView => ({ ...v, tab: 'flow' }))}
          />
          <Button
            key="tab-decisions"
            hotkey="2"
            label={t(lang, 'pane.tabDecisions', { n: questions.length })}
            variant={tab === 'decisions' ? 'primary' : 'secondary'}
            onPress={() => update($, view, (v): PaneView => ({ ...v, tab: 'decisions' }))}
          />
        </Box>
        {snapshot ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {countChips(countsOf(snapshot), lang).map(chip => (
              <Text backgroundColor={chip.color} color="inverseText">{` ${chip.label} `}</Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key="summary"
            hotkey="p"
            label={t(lang, 'pane.summary')}
            onPress={() => update($, view, v => ({ ...v, isSummaryOpen: !v.isSummaryOpen }))}
          />
          <Button
            key="report"
            hotkey="y"
            label={t(lang, 'pane.report')}
            onPress={() => ask($, lang, 'pane.reportPrompt', 'cmd.reportToast')}
          />
          <Button
            key="sync"
            hotkey="g"
            label={t(lang, 'pane.sync')}
            onPress={() => ask($, lang, 'pane.syncPrompt', 'cmd.syncToast')}
          />
        </Box>
        <Text dimColor wrap="wrap">{t(lang, 'pane.hint')}</Text>
        {isSummaryOpen && snapshot ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="bold">{t(lang, 'pane.summaryTitle')}</Text>
            {summaryLines(snapshot, lang).map(line => (
              <Text wrap="wrap">{line}</Text>
            ))}
          </Box>
        ) : null}
        {snapshot ? (
          <Box flexDirection="column" marginTop={1}>
            {tab === 'flow' ? flowRows() : decisionRows()}
          </Box>
        ) : null}
      </Box>
    )
  })
}
