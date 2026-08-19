/** @jsxImportSource @opentui/solid */
/**
 * TUI2 tool call card — the main tool-call transcript entry view.
 *
 * Replaces `tui/components/messages/tool-call.ts`'s `ToolCallComponent`
 * (a pi-tui `Container` coordinating a header Text and imperative child
 * blocks) with an opentui SolidJS view. Data flows in through props (the
 * transcript entry's `toolCallData` + result); subagent state is derived
 * by an internally-owned `SubagentStateManager` from
 * `toolCallData.subagent`, and the preview / result / subagent sections
 * come from the extracted tui2 modules.
 *
 * Layout mirrors v1 row for row: header (bullet + verb + tool label +
 * key argument + result chip + expand hint), call preview, live
 * progress / detach-hint / live-output blocks while running, result
 * body, and the subagent block. Navigation focus paints the header row
 * with the accent background; clicking the header toggles expansion.
 * Live ticking (spinner frame + elapsed seconds) is a component-local
 * interval that stops once the call reaches a terminal state.
 *
 * The tui2 transcript stores *plain* content, so the card never embeds
 * ANSI. Per-part colours in a single row are composed with opentui
 * `StyledText` chunks (`fg`/`bold`/`link` from `@opentui/core` — the
 * `span` element's prop surface is too narrow for styling). File-path
 * key arguments render as opentui link chunks instead of OSC 8 escapes.
 * Write/Edit previews drop syntax highlighting (the tui2 media
 * code-highlight is still a v1 ANSI stub) but keep the diff colour
 * structure through palette tokens.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  bold,
  dim as dimChunk,
  fg,
  link as linkChunk,
  StyledText,
  underline as underlineChunk,
} from '@opentui/core'
import type { ColorInput, TextChunk } from '@opentui/core'

import { t } from '#/i18n'
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  RESULT_PREVIEW_LINES,
  THINKING_PREVIEW_LINES,
} from '../../constant/rendering'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorToken, TextStyle } from '../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../types'
import { decodeMcpToolName } from '../../utils/mcp-tool-name'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'
import { buildCallPreview } from './tool-call/call-preview'
import {
  extractKeyArgument,
  formatElapsed,
  formatSubagentLabel,
  str,
  tailNonEmptyLines,
} from './tool-call/formatters'
import { interpretExitPlanModeOutcome } from './tool-call/plan-mode'
import { PrefixedWrappedLine } from './tool-call/prefixed-wrapped-line'
import { buildResultContent } from './tool-call/result-content'
import { SubagentStateManager } from './tool-call/subagent-state'
import type { SubagentPhase, SubToolActivity } from './tool-call/types'
import { pickChip } from './tool-renderers/chip'
import { buildGoalToolHeaderParts } from './tool-renderers/goal'
import { isGenericToolResult } from './tool-renderers/registry'
import { ShellExecutionView } from './shell-execution'

// Re-export snapshot interfaces and the key-argument helper for group views.
export { extractKeyArgument } from './tool-call/formatters'
export type { ToolCallSubagentSnapshot, ToolCallReadSnapshot } from './tool-call/types'

const PROGRESS_URL_RE = /https?:\/\/\S+/g
const MAX_LIVE_OUTPUT_CHARS = 50_000

export interface ToolCallViewProps {
  readonly toolCall: ToolCallBlockData
  readonly result?: ToolResultBlockData
  readonly expanded?: boolean
  /** Navigation-mode focus: accent background on the header row. */
  readonly navigated?: boolean
  readonly workspaceDir?: string
  /** Inline plan override captured from runtime events. */
  readonly currentPlan?: string
  /** Plan path override captured from runtime events. */
  readonly planPath?: string
  /** Live `tool.progress` lines while the call is running. */
  readonly progressLines?: readonly string[]
  /** Live combined output of the running call (host caps the buffer). */
  readonly liveOutput?: string
  /** Detach hint (Bash/Agent running in foreground, ctrl+b). */
  readonly detachHint?: boolean
  /** Fired on header click (host toggles expansion). */
  readonly onToggle?: () => void
  /** Fired when a command preview is clicked (host copies it). */
  readonly onCopyCommand?: (command: string) => void
}

export const ToolCallView: Component<ToolCallViewProps> = (props) => {
  // ── Derived state ──
  const subagent = createMemo(
    () => new SubagentStateManager(props.toolCall, props.result, props.workspaceDir),
  )
  const isSingleSubagentView = (): boolean =>
    props.toolCall.name === 'Agent' && subagent().hasState()

  // Live ticking: spinner frame + elapsed seconds while the (sub)agent card
  // is not terminal. Store-driven hosts re-render on data changes; this
  // interval covers the time-based parts v1 drove with timers.
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const phase = subagent().getDerivedPhase()
    if (phase === 'done' || phase === 'failed' || phase === 'backgrounded') return
    const id = setInterval(() => setTick((v) => v + 1), BRAILLE_SPINNER_INTERVAL_MS)
    onCleanup(() => clearInterval(id))
  })

  const headerBackground = (): ColorInput | undefined =>
    props.navigated === true ? currentTheme.color('accent') : undefined
  const showProgress = (): boolean =>
    (props.progressLines?.length ?? 0) > 0 && props.result === undefined
  const showLiveOutput = (): boolean =>
    props.result === undefined && (props.liveOutput?.length ?? 0) > 0
  const showDetachHint = (): boolean =>
    props.detachHint === true && props.result === undefined

  return (
    <Clickable
      onClick={() => {
        props.onToggle?.()
      }}
    >
      <Box flexDirection="column" backgroundColor={headerBackground()}>
        <Box flexDirection="column" paddingLeft={2}>
          <text
            wrapMode="word"
            content={buildHeader({
              toolCall: props.toolCall,
              result: props.result,
              expanded: props.expanded === true,
              workspaceDir: props.workspaceDir,
              singleSubagentView: isSingleSubagentView(),
              subagent: subagent(),
              spinnerFrame: tick() % BRAILLE_SPINNER_FRAMES.length,
            })}
          />
        </Box>
        {buildCallPreview({
          toolCall: props.toolCall,
          result: props.result,
          expanded: props.expanded === true,
          currentPlan: props.currentPlan,
          planPath: props.planPath,
          onCopyCommand: props.onCopyCommand,
        })}
        <Show when={showProgress()}>
          <Box flexDirection="column" paddingLeft={2}>
            <For each={props.progressLines ?? []}>
              {(raw) =>
                raw.length === 0 ? (
                  <Text>{' '}</Text>
                ) : (
                  <text
                    wrapMode="word"
                    content={progressLineChunks(raw)}
                  />
                )
              }
            </For>
          </Box>
        </Show>
        <Show when={showLiveOutput()}>
          <ShellExecutionView
            result={{
              tool_call_id: props.toolCall.id,
              output: (props.liveOutput ?? '').slice(0, MAX_LIVE_OUTPUT_CHARS),
              is_error: false,
            }}
            expanded={props.expanded === true}
            resultPreviewLines={RESULT_PREVIEW_LINES}
            tailOutput={true}
            expandHint={false}
          />
        </Show>
        <Show when={showDetachHint()}>
          <Box flexDirection="column" paddingLeft={2}>
            <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
              {t('tui.messages.toolCall.detachHint')}
            </Text>
          </Box>
        </Show>
        <Show when={props.result !== undefined}>
          {buildResultContent({
            toolCall: props.toolCall,
            result: props.result as ToolResultBlockData,
            expanded: props.expanded === true,
            isSingleSubagentView: isSingleSubagentView(),
          })}
        </Show>
        <Show when={subagent().hasState()}>
          <SubagentBlockView
            subagent={subagent()}
            workspaceDir={props.workspaceDir}
            tick={tick()}
          />
        </Show>
      </Box>
    </Clickable>
  )
}

// ── Styled-chunk helpers (opentui StyledText composition) ──

function run(text: string, token: ColorToken, style?: TextStyle): TextChunk {
  let chunk = fg(currentTheme.hex(token))(text)
  if (style === 'bold') chunk = bold(chunk)
  else if (style === 'dim') chunk = dimChunk(chunk)
  return chunk
}

function linkRun(text: string, url: string): TextChunk {
  return linkChunk(url)(fg(currentTheme.hex('textDim'))(text))
}

/** A styled text part: a `TextChunk` carrying its own colour/attributes. */
type TextPart = TextChunk

function lineToStyled(parts: readonly TextPart[]): StyledText {
  return new StyledText([...parts])
}

// ── Header ──

interface ToolHeaderContext {
  readonly toolCall: ToolCallBlockData
  readonly result: ToolResultBlockData | undefined
  readonly expanded: boolean
  readonly workspaceDir?: string
  readonly singleSubagentView: boolean
  readonly subagent: SubagentStateManager
  readonly spinnerFrame: number
}

function buildHeader(ctx: ToolHeaderContext): StyledText {
  const { toolCall, result } = ctx
  const isFinished = result !== undefined
  const isError = result?.is_error ?? false
  const isTruncated = toolCall.truncated === true && !isFinished

  const bullet = isFinished ? (isError ? '✗ ' : STATUS_BULLET) : isTruncated ? '✗ ' : STATUS_BULLET
  const bulletToken: ColorToken = isFinished
    ? isError
      ? 'error'
      : 'success'
    : isTruncated
      ? 'error'
      : 'text'

  if (toolCall.name === 'ExitPlanMode') {
    const parts: TextChunk[] = [
      run(t('tui.messages.toolCall.currentPlan'), 'primary', 'bold'),
    ]
    if (isFinished && !isError) {
      const outcome = interpretExitPlanModeOutcome((result as ToolResultBlockData).output)
      if (outcome.kind === 'approved') {
        if (outcome.autoApproved === true) {
          parts.push(run(t('tui.messages.toolCall.planAutoApproved'), 'success'))
        } else {
          const chipText =
            outcome.chosen !== undefined && outcome.chosen.length > 0
              ? t('tui.messages.toolCall.approvedWithOption', { option: outcome.chosen })
              : t('tui.messages.toolCall.approved')
          parts.push(run(` · ${chipText}`, 'success'))
        }
      }
    }
    return lineToStyled(parts)
  }

  if (toolCall.name === 'AskUserQuestion') {
    const isBackgroundAsk = toolCall.args['background'] === true
    const label = isFinished
      ? isError
        ? t('tui.messages.toolCall.couldNotCollectInput')
        : isBackgroundAsk
          ? t('tui.messages.toolCall.startedBackgroundQuestion')
          : t('tui.messages.toolCall.collectedAnswers')
      : isBackgroundAsk
        ? t('tui.messages.toolCall.startingBackgroundQuestion')
        : t('tui.messages.toolCall.waitingForInput')
    const tone: ColorToken = isError ? 'error' : 'primary'
    return lineToStyled([run(bullet, bulletToken), run(label, tone, 'bold')])
  }

  if (toolCall.name === 'Bash') {
    if (isTruncated) {
      return lineToStyled([
        run(bullet, 'error'),
        run(`${t('tui.messages.toolCall.verbTruncated')} `, 'error'),
        run('Bash', 'primary', 'bold'),
      ])
    }
    const label = isFinished ? t('tui.messages.toolCall.ranCommand') : t('tui.messages.toolCall.runningCommand')
    const tone: ColorToken = isError ? 'error' : 'primary'
    const parts: TextPart[] = [run(bullet, bulletToken), run(label, tone, 'bold')]
    const chip = isFinished && result !== undefined ? buildHeaderChip(toolCall, result) : null
    if (chip !== null) parts.push(chip)
    return lineToStyled(parts)
  }

  const goalParts = buildGoalToolHeaderParts({
    toolCall,
    result,
    bullet,
    chip: isFinished && result !== undefined ? headerChipText(toolCall, result) : '',
  })
  if (goalParts !== undefined) {
    const tone: ColorToken = isError ? 'error' : 'primary'
    const parts: TextPart[] = [run(goalParts.marker, tone), run(goalParts.label, tone, 'bold')]
    if (goalParts.arg !== undefined) parts.push(run(` (${goalParts.arg})`, 'textDim'))
    if (goalParts.chip.length > 0) parts.push(run(goalParts.chip, 'textDim'))
    return lineToStyled(parts)
  }

  if (ctx.singleSubagentView) {
    return buildSingleSubagentHeader(ctx)
  }

  const verb = isFinished
    ? t('tui.messages.toolCall.used')
    : isTruncated
      ? t('tui.messages.toolCall.verbTruncated')
      : t('tui.messages.toolCall.using')
  const keyArg = extractKeyArgument(toolCall.name, toolCall.args, ctx.workspaceDir)
  const decoded = decodeMcpToolName(toolCall.name)
  const parts: TextPart[] = [
    run(bullet, bulletToken),
    run(`${verb} `, isTruncated ? 'error' : 'text'),
  ]
  if (decoded !== null) {
    parts.push(run(decoded.toolName, 'primary', 'bold'))
    parts.push(run(` · MCP/${decoded.serverName}`, 'textDim'))
  } else {
    parts.push(run(toolCall.name, 'primary', 'bold'))
  }
  if (keyArg !== null) {
    const link = pathArgLink(toolCall, keyArg)
    if (link.url === undefined) {
      parts.push(run(` (${keyArg})`, 'textDim'))
    } else {
      parts.push(linkRun(` (${keyArg})`, link.url))
    }
  }
  const chip = isFinished && result !== undefined ? buildHeaderChip(toolCall, result) : null
  if (chip !== null) parts.push(chip)
  const toggleHint = ctx.expanded
    ? ` [${t('tui.messages.toolCall.footer.collapse')}]`
    : ` [${t('tui.messages.toolCall.footer.expand')}]`
  parts.push(run(toggleHint, 'textMuted'))
  return lineToStyled(parts)
}

function headerChipText(toolCall: ToolCallBlockData, result: ToolResultBlockData): string {
  const provider = pickChip(toolCall.name)
  if (provider === undefined) return ''
  const text = provider(toolCall, result)
  if (text.length === 0) return ''
  return ` · ${text}`
}

function buildHeaderChip(toolCall: ToolCallBlockData, result: ToolResultBlockData): TextPart | null {
  const text = headerChipText(toolCall, result)
  if (text.length === 0) return null
  return run(text, result.is_error ? 'error' : 'textDim')
}

/**
 * Wrap a file-path key argument (Read/Write/Edit) in an OSC8 hyperlink so
 * clicking it opens the file. Non-path arguments pass through unchanged.
 */
function pathArgLink(
  toolCall: ToolCallBlockData,
  keyArg: string,
): { text: string; url: string | undefined } {
  if (toolCall.name !== 'Read' && toolCall.name !== 'Write' && toolCall.name !== 'Edit') {
    return { text: keyArg, url: undefined }
  }
  const raw = str(toolCall.args['file_path'] ?? toolCall.args['path'])
  if (raw.length === 0) return { text: keyArg, url: undefined }
  return { text: keyArg, url: `file://${raw.replaceAll('\\', '/')}` }
}

// ── Single-subagent header ──

function buildSingleSubagentHeader(ctx: ToolHeaderContext): StyledText {
  const phase = ctx.subagent.getDerivedPhase()
  const isDone = phase === 'done'
  const labelText = formatSubagentLabel(ctx.subagent.agentNameValue)
  const marker = buildSingleSubagentMarker(phase, ctx.spinnerFrame)
  const rawDescription = str(ctx.toolCall.args['description'])
  const description =
    rawDescription.length > ctx.subagent.maxSubagentDescriptionLength
      ? `${rawDescription.slice(0, ctx.subagent.maxSubagentDescriptionLength - 1)}…`
      : rawDescription
  const statsText = formatSingleSubagentStatsText(ctx.subagent)

  if (isDone) {
    return lineToStyled([
      run(marker, 'success'),
      run(labelText, 'success', 'bold'),
      run(
        t('tui.messages.toolCall.singleSubagentCompleted', {
          description: description.length > 0 ? ` (${description})` : '',
          stats: statsText,
        }),
        'success',
      ),
    ])
  }

  const parts: TextPart[] = [run(marker, 'primary')]
  parts.push(run(labelText, 'primary', 'bold'))
  parts.push(run(formatSingleSubagentStatus(phase), phase === 'failed' ? 'error' : phase === 'backgrounded' ? 'textDim' : 'primary'))
  if (description.length > 0) parts.push(run(` (${description})`, 'textDim'))
  parts.push(run(statsText, 'textDim'))
  return lineToStyled(parts)
}

function buildSingleSubagentMarker(phase: SubagentPhase | undefined, spinnerFrame: number): string {
  if (phase === 'failed') return '✗ '
  if (phase === 'done') return STATUS_BULLET
  if (phase === 'backgrounded') return '◐ '
  const frame = BRAILLE_SPINNER_FRAMES[spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]
  return `${frame} `
}

function formatSingleSubagentStatus(phase: SubagentPhase | undefined): string {
  switch (phase) {
    case 'done':
      return t('tui.messages.toolCall.singleSubagent.completed')
    case 'failed':
      return t('tui.messages.toolCall.singleSubagent.failed')
    case 'running':
      return t('tui.messages.toolCall.singleSubagent.running')
    case 'backgrounded':
      return t('tui.messages.toolCall.singleSubagent.backgrounded')
    case 'queued':
      return t('tui.messages.toolCall.singleSubagent.queued')
    case 'spawning':
    case undefined:
      return t('tui.messages.toolCall.singleSubagent.starting')
  }
}

function formatSingleSubagentStatsText(subagent: SubagentStateManager): string {
  const parts: string[] = []
  if (subagent.modelValue !== undefined) parts.push(subagent.modelValue)
  if (subagent.effortValue !== undefined) parts.push(subagent.effortValue)
  const toolCount = subagent.subToolActivitiesMap.size
  parts.push(t('tui.messages.toolCall.singleSubagent.toolCount', { n: toolCount }))
  const elapsed = subagent.getElapsedSeconds()
  if (elapsed !== undefined) parts.push(formatElapsed(elapsed))
  return ` · ${parts.join(' · ')}`
}

// ── Progress block ──

/** Dim line with URL runs underlined in warning and hyperlinked (v1's OSC8). */
function progressLineChunks(line: string): StyledText {
  const parts: TextPart[] = []
  let last = 0
  for (const match of line.matchAll(PROGRESS_URL_RE)) {
    const index = match.index ?? 0
    if (index > last) parts.push(run(line.slice(last, index), 'textDim'))
    const url = match[0]
    if (url !== undefined) {
      const urlChunk = fg(currentTheme.hex('warning'))(url)
      parts.push(linkChunk(url)(underlineChunk(urlChunk)))
    }
    last = index + match[0].length
  }
  if (last < line.length) parts.push(run(line.slice(last), 'textDim'))
  if (parts.length === 0) return lineToStyled([run(line, 'textDim')])
  return lineToStyled(parts)
}

// ── Subagent block ──

function SubagentBlockView(props: {
  readonly subagent: SubagentStateManager
  readonly workspaceDir?: string
  readonly tick: number
}): JSX.Element {
  const isSingle = props.subagent.getToolCall().name === 'Agent'

  if (isSingle) {
    return (
      <SingleSubagentBlockView subagent={props.subagent} tick={props.tick} workspaceDir={props.workspaceDir} />
    )
  }
  return <GroupedSubagentBlockView subagent={props.subagent} workspaceDir={props.workspaceDir} />
}

/** Non-single Agent card: `↳` branch rows + finished/ongoing sub-tools + text. */
function GroupedSubagentBlockView(props: {
  readonly subagent: SubagentStateManager
  readonly workspaceDir?: string
}): JSX.Element {
  const phaseChip = formatPhaseChip(props.subagent)
  const headerLabel =
    props.subagent.agentNameValue !== undefined
      ? t('tui.messages.toolCall.subagentWithName', {
          name: props.subagent.agentNameValue,
          id: formatAgentId(props.subagent),
        })
      : t('tui.messages.toolCall.subagentNoName', { id: formatAgentId(props.subagent) })

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text
        fg={currentTheme.color('textDim')}
        attributes={currentTheme.attributes('dim')}
        wrapMode="word"
      >
        {`↳ ${headerLabel}${phaseChip}`}
      </Text>
      {props.subagent.hiddenSubCallCountValue > 0 ? (
        <Text
          fg={currentTheme.color('textDim')}
          attributes={currentTheme.attributes('italic')}
          wrapMode="word"
        >
          {`  ${t(
            props.subagent.hiddenSubCallCountValue === 1
              ? 'tui.messages.toolCall.moreToolCalls_one'
              : 'tui.messages.toolCall.moreToolCalls_other',
            { count: props.subagent.hiddenSubCallCountValue },
          )} ...`}
        </Text>
      ) : null}
      <For each={props.subagent.finishedSubCallsList}>
        {(sub) => {
          const keyArg = extractKeyArgument(sub.name, sub.args, props.workspaceDir)
          return (
            <text wrapMode="word" content={finishedSubCallChunks(sub.name, keyArg, sub.isError)} />
          )
        }}
      </For>
      <For each={[...props.subagent.ongoingSubCallsMap.values()]}>
        {(call) => {
          const keyArg = extractKeyArgument(call.name, call.args, props.workspaceDir)
          return (
            <text wrapMode="word" content={ongoingSubCallChunks(call.name, keyArg)} />
          )
        }}
      </For>
      {props.subagent.textValue.length > 0 ? (
        <For each={props.subagent.textValue.split('\n').slice(-3)}>
          {(line) => (
            <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
              {`  ${line}`}
            </Text>
          )}
        </For>
      ) : null}
      {props.subagent.phaseValue === 'done' && props.subagent.resultSummaryValue !== undefined ? (
        <For each={props.subagent.resultSummaryValue.split('\n').slice(0, 2)}>
          {(line) => (
            <Text fg={currentTheme.color('textDim')} wrapMode="word">
              {`  └ ${line}`}
            </Text>
          )}
        </For>
      ) : null}
      {props.subagent.phaseValue === 'failed' && props.subagent.errorValue !== undefined ? (
        <For each={props.subagent.errorValue.split('\n')}>
          {(line) => (
            <Text fg={currentTheme.color('error')} wrapMode="word">
              {`  └ ${line}`}
            </Text>
          )}
        </For>
      ) : null}
    </Box>
  )
}

function finishedSubCallChunks(name: string, keyArg: string | null, isError: boolean): StyledText {
  return lineToStyled([
    run(isError ? '✗' : '•', isError ? 'error' : 'success'),
    run(` ${t('tui.messages.toolCall.used')} `, 'text'),
    run(name, 'primary'),
    keyArg !== null ? run(` (${keyArg})`, 'textDim') : run('', 'text'),
  ])
}

function ongoingSubCallChunks(name: string, keyArg: string | null): StyledText {
  return lineToStyled([
    run(`… ${t('tui.messages.toolCall.using')} `, 'textDim'),
    run(name, 'primary'),
    keyArg !== null ? run(` (${keyArg})`, 'textDim') : run('', 'text'),
  ])
}

function formatPhaseChip(subagent: SubagentStateManager): string {
  const phase = subagent.phaseValue
  if (phase === undefined) return ''
  const parts: string[] = []
  switch (phase) {
    case 'queued':
      parts.push(`○ ${t('tui.messages.toolCall.phaseQueued')}`)
      break
    case 'spawning':
      parts.push(`↻ ${t('tui.messages.toolCall.phaseStarting')}`)
      break
    case 'running':
      parts.push(`↻ ${t('tui.messages.toolCall.phaseRunning')}`)
      break
    case 'done': {
      parts.push(`✓ ${t('tui.messages.toolCall.phaseDone')}`)
      const toolCount = subagent.finishedSubCallsList.length + subagent.hiddenSubCallCountValue
      if (toolCount > 0) {
        parts.push(
          t(
            toolCount === 1
              ? 'tui.messages.toolCall.toolCount_one'
              : 'tui.messages.toolCall.toolCount_other',
            { count: toolCount },
          ),
        )
      }
      const tokens = subagent.formatContextTokens() ?? subagent.formatTokensDisplay()
      if (tokens !== undefined) parts.push(tokens)
      break
    }
    case 'failed':
      parts.push(`✗ ${t('tui.messages.toolCall.phaseFailed')}`)
      break
    case 'backgrounded':
      parts.push(`◐ ${t('tui.messages.toolCall.phaseBackgrounded')}`)
      break
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function formatAgentId(subagent: SubagentStateManager): string {
  const id = subagent.agentIdValue ?? ''
  return id.length > 10 ? `${id.slice(0, 10)}…` : id
}

// ── Single-subagent block ──

function SingleSubagentBlockView(props: {
  readonly subagent: SubagentStateManager
  readonly tick: number
  readonly workspaceDir?: string
}): JSX.Element {
  const phase = props.subagent.getDerivedPhase()

  return (
    <Box flexDirection="column">
      <SingleSubagentSummaryLine subagent={props.subagent} workspaceDir={props.workspaceDir} />
      {phase === 'failed' ? (
        <SingleSubagentResultWindow kind="error" subagent={props.subagent} />
      ) : phase === 'done' || phase === 'backgrounded' ? (
        <SingleSubagentResultWindow kind="output" subagent={props.subagent} />
      ) : (
        <SingleSubagentActiveWindow subagent={props.subagent} tick={props.tick} />
      )}
    </Box>
  )
}

function SingleSubagentSummaryLine(props: {
  readonly subagent: SubagentStateManager
  readonly workspaceDir?: string
}): JSX.Element {
  const toolCount = props.subagent.subToolActivitiesMap.size
  const countLabel = t(
    toolCount === 1
      ? 'tui.messages.toolCall.toolCount_one'
      : 'tui.messages.toolCall.toolCount_other',
    { count: toolCount },
  )
  const current = getCurrentSubToolActivity(props.subagent)
  if (current === undefined) {
    return (
      <Text fg={currentTheme.color('textDim')} wrapMode="word">
        {`  · ${countLabel}`}
      </Text>
    )
  }
  const verb = current.phase === 'ongoing' ? t('tui.messages.toolCall.using') : t('tui.messages.toolCall.used')
  const keyArg = extractKeyArgument(current.name, current.args, props.workspaceDir)
  const mark = current.phase === 'failed' ? ' ✗' : current.phase === 'done' ? ' ✓' : ''
  return (
    <Text fg={currentTheme.color('textDim')} wrapMode="word">
      {`  · ${countLabel} · `}
      {verb} {current.name}
      {keyArg !== null ? ` (${keyArg})` : ''}
      {mark.length > 0 ? mark : ''}
    </Text>
  )
}

function SingleSubagentActiveWindow(props: {
  readonly subagent: SubagentStateManager
  readonly tick: number
}): JSX.Element {
  const content = getActiveSubagentContent(props.subagent)
  const isThinking = content?.tone === 'thinking'
  return (
    <PrefixedWrappedLine
      firstPrefix={`  │ `}
      continuationPrefix={`  │ `}
      text={content === undefined ? '…' : content.text}
      tailLines={THINKING_PREVIEW_LINES}
      minLines={THINKING_PREVIEW_LINES}
      fg={currentTheme.color('textDim')}
      attributes={isThinking ? currentTheme.attributes('dim') : undefined}
    />
  )
}

function SingleSubagentResultWindow(props: {
  readonly kind: 'output' | 'error'
  readonly subagent: SubagentStateManager
}): JSX.Element {
  const source = props.kind === 'error' ? props.subagent.errorValue : props.subagent.textValue
  const text = source === undefined ? '' : tailNonEmptyLines(source, 2).join('\n')
  const fg = props.kind === 'error' ? currentTheme.color('error') : currentTheme.color('text')
  return (
    <PrefixedWrappedLine
      firstPrefix={`  │ `}
      continuationPrefix={`  │ `}
      text={text}
      tailLines={THINKING_PREVIEW_LINES}
      minLines={THINKING_PREVIEW_LINES}
      fg={fg}
    />
  )
}

function getCurrentSubToolActivity(
  subagent: SubagentStateManager,
): SubToolActivity | undefined {
  let latestOngoing: SubToolActivity | undefined
  let latest: SubToolActivity | undefined
  for (const activity of subagent.subToolActivitiesMap.values()) {
    if (latest === undefined || activity.orderSeq > latest.orderSeq) latest = activity
    if (
      activity.phase === 'ongoing' &&
      (latestOngoing === undefined || activity.orderSeq > latestOngoing.orderSeq)
    ) {
      latestOngoing = activity
    }
  }
  return latestOngoing ?? latest
}

function getActiveSubagentContent(
  subagent: SubagentStateManager,
): { text: string; tone: 'text' | 'thinking' } | undefined {
  const current = getCurrentSubToolActivity(subagent)
  if (
    current?.phase === 'ongoing' &&
    current.output !== undefined &&
    current.output.trim().length > 0 &&
    (current.name === 'Bash' || isGenericToolResult(current.name))
  ) {
    return { text: current.output, tone: 'text' }
  }
  const text = subagent.textValue.trim()
  if (text.length > 0) return { text, tone: 'text' }
  return undefined
}
