/** @jsxImportSource @opentui/solid */
/**
 * TUI2 Read group view — renders 2+ Read tool calls from the same step
 * as one group.
 *
 * Replaces `tui/components/messages/read-group.ts`'s
 * `ReadGroupComponent` (a pi-tui `Container` with throttled snapshot
 * repaints) with an opentui SolidJS view. Each member's read snapshot is
 * derived from its transcript entry data (`getReadSnapshot`); the view
 * re-renders when the store changes — the 200ms throttle is gone.
 *
 * Header forms match v1:
 *   pending > 0: Reading {N} files
 *   all done:    Read {N} files · {L} lines
 *   some failed: append · {F} failed
 *   all failed:  Read {N} files · failed
 *
 * Body lines follow the group branch style (`├─`/`└─`).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For } from 'solid-js'
import { bold, dim as dimChunk, fg, StyledText } from '@opentui/core'
import type { TextChunk } from '@opentui/core'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorToken } from '../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { SubagentStateManager } from './tool-call/subagent-state'
import type { ToolCallReadSnapshot } from './tool-call/types'

export interface ReadGroupMember {
  readonly toolCallId: string
  readonly toolCall: ToolCallBlockData
  readonly result?: ToolResultBlockData
  readonly workspaceDir?: string
}

export interface ReadGroupViewProps {
  readonly members: readonly ReadGroupMember[]
}

export const ReadGroupView: Component<ReadGroupViewProps> = (props) => {
  const snapshots = (): ToolCallReadSnapshot[] =>
    props.members.map((member) =>
      new SubagentStateManager(member.toolCall, member.result, member.workspaceDir).getReadSnapshot(),
    )
  const visible = (): ToolCallReadSnapshot[] =>
    snapshots().filter((s) => s.filePath !== undefined && s.filePath.length > 0)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <text wrapMode="word" content={buildHeaderChunks(snapshots())} />
      <For each={visible()}>
        {(snap, index) => (
          <Text fg={currentTheme.color('text')} wrapMode="word">
            {buildBodyLine(snap, index() === visible().length - 1)}
          </Text>
        )}
      </For>
    </Box>
  )
}

function buildHeaderChunks(snapshots: readonly ToolCallReadSnapshot[]): StyledText {
  const total = snapshots.length
  let pending = 0
  let failed = 0
  let totalLines = 0
  for (const snap of snapshots) {
    if (snap.phase === 'pending') pending += 1
    else if (snap.phase === 'failed') failed += 1
    else totalLines += snap.lines
  }

  if (pending > 0) {
    return lineToStyled([
      run(STATUS_BULLET, 'text'),
      run(t('tui.messages.readGroup.readingFiles', { count: total }), 'primary', 'bold'),
    ])
  }

  if (failed === total) {
    return lineToStyled([
      run('✗ ', 'error'),
      run(t('tui.messages.readGroup.readFiles', { count: total }), 'error', 'bold'),
      run(` · ${t('tui.messages.readGroup.failed')}`, 'error'),
    ])
  }

  const linesPart = ` · ${t(
    totalLines === 1 ? 'tui.messages.readGroup.line_one' : 'tui.messages.readGroup.line_other',
    { count: totalLines },
  )}`
  const failPart = failed > 0 ? ` · ${String(failed)} ${t('tui.messages.readGroup.failed')}` : ''
  return new StyledText([
    run(STATUS_BULLET, 'success'),
    run(t('tui.messages.readGroup.readFiles', { count: total }), 'primary', 'bold'),
    run(linesPart, 'textDim'),
    run(failPart, 'error'),
  ])
}

function buildBodyLine(snap: ToolCallReadSnapshot, isLast: boolean): string {
  const branch = isLast ? '└─' : '├─'
  const path = snap.filePath ?? ''
  let tail: string
  if (snap.phase === 'pending') {
    tail = ` · ${t('tui.messages.readGroup.reading')}`
  } else if (snap.phase === 'failed') {
    tail = ` · ${t('tui.messages.readGroup.failed')}`
  } else {
    tail = ` · ${t(
      snap.lines === 1 ? 'tui.messages.readGroup.line_one' : 'tui.messages.readGroup.line_other',
      { count: snap.lines },
    )}`
  }
  return `  ${branch} ${path}${tail}`
}

// ── Chunk helpers ──

function run(text: string, token: ColorToken, style?: 'bold' | 'dim'): TextChunk {
  let chunk = fg(currentTheme.hex(token))(text)
  if (style === 'bold') chunk = bold(chunk)
  else if (style === 'dim') chunk = dimChunk(chunk)
  return chunk
}

function lineToStyled(parts: readonly TextChunk[]): StyledText {
  return new StyledText([...parts])
}
