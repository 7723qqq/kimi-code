/** @jsxImportSource @opentui/solid */
/**
 * TUI2 call preview builder — renders the "what is this tool about to
 * do" section of a tool call card.
 *
 * Replaces `tui/components/messages/tool-call/call-preview.ts`'s
 * `buildCallPreview` (which returned pi-tui `Component[]`) with a pure
 * dispatcher returning a SolidJS element. Per-tool previews:
 *
 *   - ExitPlanMode  → PlanBoxView (opentui bordered box + markdown)
 *   - truncated args → dim truncated marker
 *   - streaming args → streaming preview (Write/Edit/Bash)
 *   - Write → numbered source rows (syntax highlighting is dropped: the
 *     tui2 media code-highlight is still a v1 stub returning ANSI)
 *   - Edit → plain clustered diff (`computeDiffLines` + v1's cluster
 *     shape, rendered with diff colour tokens)
 *   - Bash → ShellExecutionView (command preview, click to copy)
 *
 * The `markdownTheme` context field is gone — PlanBoxView owns its
 * markdown styling through the tui2 theme.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { JSX } from 'solid-js'
import { fg, StyledText } from '@opentui/core'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { COMMAND_PREVIEW_LINES } from '../../../constant/rendering'
import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '../../../constant/streaming'
import { currentTheme } from '../../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../../types'
import { computeDiffLines, type DiffLine } from '../../media/diff-preview'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { PlanBoxView } from '../plan-box'
import { ShellExecutionView } from '../shell-execution'
import { formatByteSize, formatElapsed, str } from './formatters'
import {
  extractApprovedPlan,
  interpretExitPlanModeOutcome,
  isExitPlanModeOutcomeOutput,
} from './plan-mode'
import { extractPartialStringField } from './streaming-preview'

/** Inputs needed to render the call preview block. */
export interface CallPreviewContext {
  readonly toolCall: ToolCallBlockData
  readonly result: ToolResultBlockData | undefined
  readonly expanded: boolean
  /** Inline plan override captured from runtime events. */
  readonly currentPlan?: string
  /** Plan path override captured from runtime events. */
  readonly planPath?: string
  /** Fired when a Bash command preview is clicked (host copies it). */
  readonly onCopyCommand?: (command: string) => void
}

/**
 * Build the call preview section.
 *
 * Dispatches to:
 *   - ExitPlanMode -> plan box preview
 *   - truncated args -> truncated marker
 *   - streaming args -> streaming preview (Write/Edit/Bash)
 *   - Write -> numbered source preview
 *   - Edit -> diff preview
 *   - Bash -> shell execution preview
 *
 * Tools without a dedicated preview produce an empty element.
 */
export function buildCallPreview(ctx: CallPreviewContext): JSX.Element {
  const { toolCall, result, expanded } = ctx
  const name = toolCall.name

  if (name === 'ExitPlanMode') return buildPlanPreview(ctx)

  if (result === undefined && toolCall.truncated === true) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
          {t('tui.messages.toolCall.argumentsTruncated')}
        </Text>
      </Box>
    )
  }

  if (result === undefined && toolCall.streamingArguments !== undefined) {
    return buildStreamingPreview(toolCall.streamingArguments, toolCall, expanded)
  }

  const shouldCap = !expanded
  if (name === 'Write') return buildWritePreview(toolCall, shouldCap)
  if (name === 'Edit') return buildEditPreview(toolCall, shouldCap)
  if (name === 'Bash') return buildBashPreview(toolCall, expanded, ctx.onCopyCommand)
  return <></>
}

// ── Write preview ──

/** Numbered source row: dim gutter + body text, composed as styled chunks. */
function numberedLine(lineNumber: number, code: string): StyledText {
  return new StyledText([
    fg(currentTheme.hex('textDim'))(`${String(lineNumber).padStart(4)}  `),
    fg(currentTheme.hex('text'))(code),
  ])
}

function buildWritePreview(toolCall: ToolCallBlockData, shouldCap: boolean): JSX.Element {
  const content = str(toolCall.args['content'])
  if (content.length === 0) return <></>
  const allLines = content.split('\n')
  const shown = shouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines
  const remaining = allLines.length - shown.length

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((line, i) => (
        <text wrapMode="word" content={numberedLine(i + 1, line)} />
      ))}
      {shouldCap && remaining > 0 ? (
        <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
          {t('tui.messages.toolCall.moreLinesHint', {
            remaining,
            total: allLines.length,
          })}
        </Text>
      ) : null}
    </Box>
  )
}

// ── Edit preview ──

/** One plain diff row; the view maps `kind` to a colour token. */
export interface EditPreviewRow {
  readonly kind: 'header' | 'add' | 'delete' | 'context' | 'separator'
  readonly text: string
}

/**
 * Clustered diff rows mirroring v1's `renderDiffLinesClustered` shape
 * (hunks with context, `… N unchanged lines …` separators, capped at
 * `maxLines` with a `ctrl+o` footer) as plain text + row kinds.
 */
export function buildEditPreviewRows(
  oldStr: string,
  newStr: string,
  filePath: string,
  options: { readonly maxLines: number; readonly contextLines?: number },
): EditPreviewRow[] {
  const contextLines = options.contextLines ?? 3
  const diffLines = computeDiffLines(oldStr, newStr)
  const { clusters, changedCount, addedCount, removedCount } = buildClusters(
    diffLines,
    contextLines,
  )

  const rows: EditPreviewRow[] = []
  let header = ''
  if (addedCount > 0) header += `+${String(addedCount)} `
  if (removedCount > 0) header += `-${String(removedCount)} `
  header += filePath
  rows.push({ kind: 'header', text: header })

  if (clusters.length === 0) return rows

  const cap = options.maxLines >= 0 ? options.maxLines : Number.POSITIVE_INFINITY
  let body = 0
  let prevEnd = -1
  let truncated = false
  let shownChanges = 0

  outer: for (const cluster of clusters) {
    if (body >= cap) {
      truncated = true
      break
    }
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1
      if (gap > 0) {
        if (body + 1 > cap) {
          truncated = true
          break
        }
        rows.push({
          kind: 'separator',
          text: `     … ${t('tui.diffPreview.unchangedLines', { n: gap })}`,
        })
        body++
      }
    }
    for (let i = cluster.start; i <= cluster.end; i++) {
      if (body >= cap) {
        truncated = true
        break outer
      }
      const line = diffLines[i]
      if (line === undefined) continue
      rows.push(formatDiffRow(line))
      body++
      if (line.kind !== 'context') shownChanges++
      prevEnd = i
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges
    if (hidden > 0) {
      rows.push({
        kind: 'separator',
        text: `     … ${t('tui.diffPreview.moreChangesHiddenWithHint', { n: hidden, hint: 'ctrl+o' })}`,
      })
    }
  }
  return rows
}

function formatDiffRow(line: DiffLine): EditPreviewRow {
  const gutter = `${String(line.lineNum).padStart(4)} `
  if (line.kind === 'add') return { kind: 'add', text: `${gutter}+ ${line.code}` }
  if (line.kind === 'delete') return { kind: 'delete', text: `${gutter}- ${line.code}` }
  return { kind: 'context', text: `${gutter}  ${line.code}` }
}

interface DiffCluster {
  readonly start: number
  readonly end: number
}

/** Group changed lines into hunks with `contextLines` of context on each side. */
function buildClusters(
  diffLines: readonly DiffLine[],
  contextLines: number,
): { clusters: DiffCluster[]; changedCount: number; addedCount: number; removedCount: number } {
  const changeIndices: number[] = []
  let added = 0
  let removed = 0
  for (const [i, line] of diffLines.entries()) {
    if (line.kind === 'add') {
      added++
      changeIndices.push(i)
    } else if (line.kind === 'delete') {
      removed++
      changeIndices.push(i)
    }
  }

  const clusters: DiffCluster[] = []
  if (changeIndices.length === 0) {
    return { clusters, changedCount: 0, addedCount: added, removedCount: removed }
  }

  const mergeGap = 2 * contextLines
  let groupStart = changeIndices[0]!
  let groupEnd = changeIndices[0]!
  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      })
      groupStart = idx
      groupEnd = idx
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  })

  return {
    clusters,
    changedCount: changeIndices.length,
    addedCount: added,
    removedCount: removed,
  }
}

function buildEditPreview(toolCall: ToolCallBlockData, shouldCap: boolean): JSX.Element {
  const oldStr = str(toolCall.args['old_string'])
  const newStr = str(toolCall.args['new_string'])
  if (oldStr.length === 0 && newStr.length === 0) return <></>
  const filePath = str(toolCall.args['file_path'] ?? toolCall.args['path'])
  const rows = buildEditPreviewRows(oldStr, newStr, filePath, {
    maxLines: shouldCap ? COMMAND_PREVIEW_LINES : Number.POSITIVE_INFINITY,
    contextLines: 3,
  })

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((row) => (
        <Text fg={diffRowColor(row.kind)} wrapMode="word">
          {row.text}
        </Text>
      ))}
    </Box>
  )
}

function diffRowColor(kind: EditPreviewRow['kind']): ColorInput {
  switch (kind) {
    case 'header':
    case 'separator':
      return currentTheme.color('diffMeta')
    case 'add':
      return currentTheme.color('diffAdded')
    case 'delete':
      return currentTheme.color('diffRemoved')
    case 'context':
      return currentTheme.color('text')
  }
}

// ── Bash preview ──

function buildBashPreview(
  toolCall: ToolCallBlockData,
  expanded: boolean,
  onCopyCommand: ((command: string) => void) | undefined,
): JSX.Element {
  const command = str(toolCall.args['command'])
  if (command.length === 0) return <></>
  return (
    <ShellExecutionView
      command={command}
      showCommand={true}
      commandPreviewLines={expanded ? undefined : COMMAND_PREVIEW_LINES}
      onCopyCommand={onCopyCommand}
    />
  )
}

// ── Streaming preview ──

function buildStreamingPreview(
  streamText: string,
  toolCall: ToolCallBlockData,
  expanded: boolean,
): JSX.Element {
  const name = toolCall.name
  const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS)

  if (name === 'Write') return buildStreamingWritePreview(previewText)
  if (name === 'Edit') return buildStreamingEditPreview(previewText, toolCall)
  if (name === 'Bash') return buildStreamingBashPreview(previewText, expanded)
  return <></>
}

function buildStreamingWritePreview(previewText: string): JSX.Element {
  const content = extractPartialStringField(previewText, 'content')
  if (content === undefined || content.length === 0) return <></>
  const allLines = content.split('\n')
  const maxLines = COMMAND_PREVIEW_LINES
  const scrollLines =
    allLines.length > maxLines ? allLines.slice(allLines.length - maxLines) : allLines

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {scrollLines.map((line, i) => {
        const originalLineNumber = allLines.length > maxLines ? allLines.length - maxLines + i : i
        return <text wrapMode="word" content={numberedLine(originalLineNumber + 1, line)} />
      })}
    </Box>
  )
}

function buildStreamingEditPreview(previewText: string, toolCall: ToolCallBlockData): JSX.Element {
  const filePath =
    extractPartialStringField(previewText, 'file_path') ??
    extractPartialStringField(previewText, 'path') ??
    ''
  const bytes = Buffer.byteLength(previewText, 'utf8')
  const startedAtMs = toolCall.streamingStartedAtMs
  const elapsedSeconds =
    startedAtMs === undefined ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
  const target =
    filePath.length > 0 ? t('tui.messages.toolCall.preparingChangesTarget', { filePath }) : ''
  const progress = t('tui.messages.toolCall.preparingChanges', {
    target,
    size: formatByteSize(bytes),
    elapsed: formatElapsed(elapsedSeconds),
  })
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
        {progress}
      </Text>
    </Box>
  )
}

function buildStreamingBashPreview(previewText: string, expanded: boolean): JSX.Element {
  const cmd = extractPartialStringField(previewText, 'command')
  if (cmd === undefined || cmd.length === 0) return <></>
  return (
    <ShellExecutionView
      command={cmd}
      showCommand={true}
      commandPreviewLines={expanded ? undefined : COMMAND_PREVIEW_LINES}
    />
  )
}

// ── Plan preview (ExitPlanMode) ──

function buildPlanPreview(ctx: CallPreviewContext): JSX.Element {
  const plan = resolvePlanForPreview(ctx)
  if (plan.length === 0) return <></>
  const path = resolvePlanPath(ctx)
  const status = resolvePlanBoxStatus(ctx)
  return (
    <PlanBoxView
      plan={plan}
      borderHex={currentTheme.hex('success')}
      planPath={path}
      status={status}
    />
  )
}

function resolvePlanForPreview(ctx: CallPreviewContext): string {
  const inlinePlan = str(ctx.toolCall.args['plan'])
  if (inlinePlan.length > 0) return inlinePlan
  if (ctx.result !== undefined && !ctx.result.is_error) {
    const approved = extractApprovedPlan(ctx.result.output)
    if (approved.length > 0) return approved
  }
  return ctx.currentPlan ?? ''
}

function resolvePlanPath(ctx: CallPreviewContext): string | undefined {
  if (ctx.result !== undefined && !ctx.result.is_error) {
    const fromResult = interpretExitPlanModeOutcome(ctx.result.output).path
    if (fromResult !== undefined && fromResult.length > 0) return fromResult
  }
  return ctx.planPath
}

function resolvePlanBoxStatus(
  ctx: CallPreviewContext,
): { label: string; colorHex: string } | undefined {
  const result = ctx.result
  if (ctx.toolCall.name !== 'ExitPlanMode' || result === undefined) return undefined
  if (!isExitPlanModeOutcomeOutput(result.output)) return undefined
  const outcome = interpretExitPlanModeOutcome(result.output)
  if (outcome.kind !== 'rejected') return undefined
  return { label: t('tui.messages.toolCall.rejected'), colorHex: currentTheme.hex('error') }
}
