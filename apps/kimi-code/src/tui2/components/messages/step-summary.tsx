/** @jsxImportSource @opentui/solid */
/**
 * TUI2 step summary view — a collapsed summary of older content within a
 * turn.
 *
 * Replaces `tui/components/messages/step-summary.ts`'s
 * `StepSummaryComponent`. Accumulates counts of merged steps (thinking
 * blocks and tool calls) and folded assistant messages, rendering them as a
 * single muted line, e.g. `… thinking 5 times, call 50 tools, 12 messages`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface StepSummaryCounts {
  readonly thinking: number
  readonly tool: number
  readonly assistant: number
}

export interface StepSummaryViewProps {
  readonly counts: StepSummaryCounts
}

export const StepSummaryView: Component<StepSummaryViewProps> = (props) => {
  const parts = (): string[] => {
    const result: string[] = []
    if (props.counts.thinking > 0) result.push(`thinking ${String(props.counts.thinking)} times`)
    if (props.counts.tool > 0) result.push(`call ${String(props.counts.tool)} tools`)
    if (props.counts.assistant > 0) result.push(`${String(props.counts.assistant)} messages`)
    return result
  }
  const line = (): string => {
    const items = parts()
    return items.length === 0 ? '' : `… ${items.join(', ')}`
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
        {line()}
      </Text>
    </Box>
  )
}
