/** @jsxImportSource @opentui/solid */
/**
 * TUI2 Agent group view — renders 2+ Agent tool calls from the same step
 * as one group.
 *
 * Replaces `tui/components/messages/agent-group.ts`'s
 * `AgentGroupComponent` (a pi-tui `Container` that *borrowed* child
 * `ToolCallComponent`s as hidden state containers and throttled repaints
 * on snapshot changes) with an opentui SolidJS view. The tui2 data model
 * has no imperative children: each group member's state is derived from
 * its transcript entry's `toolCallData` through a per-member
 * `SubagentStateManager`, and the view re-renders when the store
 * changes. The 200ms throttle is gone — SolidJS reactivity coalesces
 * store updates; only the elapsed-seconds tail needs a local 1s tick
 * while any member is still live.
 *
 * Header and branch-line shapes match v1 (bullets, breakdown parts,
 * `├─`/`└─` trees, phase tails); colours resolve through palette tokens
 * and per-part rows are composed as opentui `StyledText` chunks.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { bold, dim as dimChunk, fg, StyledText } from '@opentui/core'
import type { TextChunk } from '@opentui/core'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorToken, TextStyle } from '../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { SubagentStateManager } from './tool-call/subagent-state'
import type { ToolCallSubagentSnapshot } from './tool-call/types'

const ELAPSED_TICK_MS = 1000

export interface AgentGroupMember {
  readonly toolCallId: string
  readonly toolCall: ToolCallBlockData
  readonly result?: ToolResultBlockData
  readonly workspaceDir?: string
}

export interface AgentGroupViewProps {
  readonly members: readonly AgentGroupMember[]
}

export const AgentGroupView: Component<AgentGroupViewProps> = (props) => {
  const snapshots = (): ToolCallSubagentSnapshot[] =>
    props.members.map((member) =>
      new SubagentStateManager(member.toolCall, member.result, member.workspaceDir).getSnapshot(),
    )

  // Refresh the elapsed tail once a second while any member is still live.
  const [, setTick] = createSignal(0)
  createEffect(() => {
    const live = snapshots().some(
      (snap) =>
        snap.phase === 'running' ||
        snap.phase === 'queued' ||
        snap.phase === 'spawning' ||
        snap.phase === undefined,
    )
    if (!live) return
    const id = setInterval(() => setTick((v) => v + 1), ELAPSED_TICK_MS)
    onCleanup(() => clearInterval(id))
  })

  const anyLive = (): boolean =>
    snapshots().some((s) => s.phase === 'running' || s.phase === 'queued' || s.phase === 'spawning' || s.phase === undefined)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <text wrapMode="word" content={buildHeaderChunks(snapshots())} />
      <For each={snapshots()}>
        {(snap, index) => (
          <GroupMemberRows snap={snap} isLast={index() === snapshots().length - 1} />
        )}
      </For>
      <Show when={anyLive()}>
        <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
          {t('tui.messages.agentGroup.detachHint')}
        </Text>
      </Show>
    </Box>
  )
}

// ── Chunk helpers ──

function run(text: string, token: ColorToken, style?: TextStyle): TextChunk {
  let chunk = fg(currentTheme.hex(token))(text)
  if (style === 'bold') chunk = bold(chunk)
  else if (style === 'dim') chunk = dimChunk(chunk)
  return chunk
}

function lineToStyled(parts: readonly TextChunk[]): StyledText {
  return new StyledText([...parts])
}

// ── Header ──

function buildHeaderChunks(snapshots: readonly ToolCallSubagentSnapshot[]): StyledText {
  const total = snapshots.length
  const counts = countPhases(snapshots)
  const allDone = counts.terminal === total
  const bulletToken: ColorToken = allDone ? 'success' : 'text'
  const elapsedSeconds = maxElapsedSeconds(snapshots)

  if (allDone) {
    const types = new Set(snapshots.map((s) => s.agentName).filter((n) => n !== undefined))
    const headerLabel =
      types.size === 1
        ? t('tui.messages.agentGroup.finishedWithType', {
            count: total,
            type: [...types][0] ?? '',
          })
        : t('tui.messages.agentGroup.finished', { count: total })
    const totalTools = snapshots.reduce((acc, s) => acc + s.toolCount, 0)
    const totalTokens = snapshots.reduce((acc, s) => acc + s.tokens, 0)
    const tail = formatHeaderTail({ toolCount: totalTools, tokens: totalTokens, elapsedSeconds })
    return lineToStyled([
      run(STATUS_BULLET, bulletToken),
      run(headerLabel, 'primary', 'bold'),
      run(tail, 'textDim'),
    ])
  }

  const parts = formatBreakdownParts(counts)
  const headerText =
    parts.length > 0
      ? t('tui.messages.agentGroup.runningWithBreakdown', {
          count: total,
          breakdown: parts.join(', '),
        })
      : t('tui.messages.agentGroup.running', { count: total })
  const tail = formatHeaderTail({ toolCount: 0, tokens: 0, elapsedSeconds })
  return lineToStyled([
    run(STATUS_BULLET, 'text'),
    run(headerText, 'primary', 'bold'),
    run(tail, 'textDim'),
  ])
}

interface PhaseCounts {
  readonly done: number
  readonly failed: number
  readonly backgrounded: number
  readonly running: number
  readonly waiting: number
  readonly starting: number
  readonly terminal: number
}

function countPhases(snapshots: readonly ToolCallSubagentSnapshot[]): PhaseCounts {
  let done = 0
  let failed = 0
  let backgrounded = 0
  let running = 0
  let waiting = 0
  let starting = 0

  for (const snap of snapshots) {
    switch (snap.phase) {
      case 'done':
        done += 1
        break
      case 'failed':
        failed += 1
        break
      case 'backgrounded':
        backgrounded += 1
        break
      case 'queued':
        waiting += 1
        break
      case 'running':
        running += 1
        break
      case 'spawning':
      case undefined:
        starting += 1
        break
    }
  }

  return {
    done,
    failed,
    backgrounded,
    running,
    waiting,
    starting,
    terminal: done + failed + backgrounded,
  }
}

function formatBreakdownParts(counts: PhaseCounts): string[] {
  const parts: string[] = []
  if (counts.done > 0) parts.push(t('tui.messages.agentGroup.breakdown.done', { n: counts.done }))
  if (counts.failed > 0)
    parts.push(t('tui.messages.agentGroup.breakdown.failed', { n: counts.failed }))
  if (counts.backgrounded > 0)
    parts.push(t('tui.messages.agentGroup.breakdown.backgrounded', { n: counts.backgrounded }))
  if (counts.running > 0)
    parts.push(t('tui.messages.agentGroup.breakdown.running', { n: counts.running }))
  if (counts.waiting > 0)
    parts.push(t('tui.messages.agentGroup.breakdown.waiting', { n: counts.waiting }))
  if (counts.starting > 0)
    parts.push(t('tui.messages.agentGroup.breakdown.starting', { n: counts.starting }))
  return parts
}

function formatHeaderTail(args: {
  readonly toolCount: number
  readonly tokens: number
  readonly elapsedSeconds: number | undefined
}): string {
  const parts: string[] = []
  if (args.toolCount > 0) {
    parts.push(
      args.toolCount === 1
        ? t('tui.messages.agentGroup.tool_one', { count: args.toolCount })
        : t('tui.messages.agentGroup.tool_other', { count: args.toolCount }),
    )
  }
  if (args.tokens > 0) parts.push(formatTokens(args.tokens))
  if (args.elapsedSeconds !== undefined) parts.push(formatElapsed(args.elapsedSeconds))
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function maxElapsedSeconds(snapshots: readonly ToolCallSubagentSnapshot[]): number | undefined {
  let max: number | undefined
  for (const snap of snapshots) {
    const elapsed = snap.elapsedSeconds
    if (elapsed === undefined) continue
    max = max === undefined ? elapsed : Math.max(max, elapsed)
  }
  return max
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return t('tui.messages.agentGroup.elapsedSeconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return t('tui.messages.agentGroup.elapsedMinutes', { minutes, seconds: remainder })
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return t('tui.messages.agentGroup.tokens', { count: 0 })
  if (n >= 1024 * 1024) {
    const m = n / (1024 * 1024)
    const count = m >= 100 ? Math.round(m) : Number(trimTokenDecimal(m))
    return t('tui.messages.agentGroup.tokensM', { count })
  }
  if (n >= 1024) {
    const k = n / 1024
    const count = k >= 100 ? Math.round(k) : Number(trimTokenDecimal(k))
    return t('tui.messages.agentGroup.tokensK', { count })
  }
  return t('tui.messages.agentGroup.tokens', { count: n })
}

function trimTokenDecimal(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

// ── Body rows ──

function GroupMemberRows(props: {
  readonly snap: ToolCallSubagentSnapshot
  readonly isLast: boolean
}): JSX.Element {
  const { snap, isLast } = props
  const branch1 = isLast ? '└─' : '├─'
  const agentType = snap.agentName ?? t('tui.messages.agentGroup.agentDefault')
  const desc = snap.toolCallDescription || t('tui.messages.agentGroup.noDescription')
  const tail = formatLineTail(snap)
  const stats = formatStats(snap)
  const firstLine = lineToStyled([
    run(`  ${branch1} `, 'textDim'),
    run(agentType, 'primary'),
    run(`· ${desc}`, 'textDim'),
    run(stats, 'textDim'),
    ...tail,
  ])

  const branch2 = isLast ? '   ' : '│  '
  if (snap.phase === 'failed') {
    const errLine =
      (snap.errorText ?? t('tui.messages.agentGroup.failed')).split('\n').at(0) ??
      t('tui.messages.agentGroup.failed')
    return (
      <Box flexDirection="column">
        <text wrapMode="word" content={firstLine} />
        <Text fg={currentTheme.color('error')} wrapMode="word">
          {`  ${branch2}    ${t('tui.messages.agentGroup.errorPrefix', { error: errLine })}`}
        </Text>
      </Box>
    )
  }
  if (snap.phase === 'done' || snap.phase === 'backgrounded') {
    return <text wrapMode="word" content={firstLine} />
  }
  const activity = snap.latestActivity ?? fallbackActivityForPhase(snap.phase)
  return (
    <Box flexDirection="column">
      <text wrapMode="word" content={firstLine} />
      <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
        {`  ${branch2}    ${activity}`}
      </Text>
    </Box>
  )
}

function formatStats(snap: ToolCallSubagentSnapshot): string {
  const parts: string[] = []
  if (snap.model !== undefined) parts.push(snap.model)
  if (snap.effort !== undefined) parts.push(snap.effort)
  parts.push(
    snap.toolCount === 1
      ? t('tui.messages.agentGroup.tool_one', { count: snap.toolCount })
      : t('tui.messages.agentGroup.tool_other', { count: snap.toolCount }),
  )
  if (snap.elapsedSeconds !== undefined) parts.push(formatElapsed(snap.elapsedSeconds))
  if (snap.tokens > 0) parts.push(formatTokens(snap.tokens))
  return ` · ${parts.join(' · ')}`
}

function formatLineTail(snap: ToolCallSubagentSnapshot): TextChunk[] {
  const separator = run(' · ', 'textDim')
  switch (snap.phase) {
    case 'done':
      return [separator, run(t('tui.messages.agentGroup.completed'), 'success')]
    case 'failed':
      return [separator, run(t('tui.messages.agentGroup.failed'), 'error')]
    case 'backgrounded':
      return [separator, run(t('tui.messages.agentGroup.backgrounded'), 'textDim')]
    case 'queued':
      return [separator, run(t('tui.messages.agentGroup.waiting'), 'primary')]
    case 'running':
      return [separator, run(t('tui.messages.agentGroup.runningLabel'), 'primary')]
    case 'spawning':
    case undefined:
      return [separator, run(t('tui.messages.agentGroup.starting'), 'primary')]
  }
}

function fallbackActivityForPhase(phase: ToolCallSubagentSnapshot['phase']): string {
  switch (phase) {
    case 'queued':
      return t('tui.messages.agentGroup.fallbackWaiting')
    case 'running':
      return t('tui.messages.agentGroup.fallbackRunning')
    case 'spawning':
    case undefined:
      return t('tui.messages.agentGroup.fallbackStarting')
    case 'done':
    case 'failed':
    case 'backgrounded':
      return ''
  }
}
