/** @jsxImportSource @opentui/solid */
/**
 * TUI2 status / notice message views.
 *
 * Replaces `tui/components/messages/status-message.ts`'s
 * `StatusMessageComponent` / `NoticeMessageComponent` (pi-tui Containers
 * rendering ANSI strings) with opentui SolidJS views that render a
 * transcript entry's content with a semantic color token.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import type { ColorToken } from '../../theme'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface StatusMessageViewProps {
  readonly content: string
  readonly color?: ColorToken
}

/** A muted status line, indented two cells (mirrors the v1 component). */
export const StatusMessageView: Component<StatusMessageViewProps> = (props) => {
  const fg = (): ColorInput =>
    props.color === undefined
      ? currentTheme.color('textDim')
      : currentTheme.color(props.color)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text fg={fg()} wrapMode="word">
        {props.content}
      </Text>
    </Box>
  )
}

export interface NoticeMessageViewProps {
  readonly title: string
  readonly detail?: string
}

/** A notice: bold title + optional dim detail, indented two cells. */
export const NoticeMessageView: Component<NoticeMessageViewProps> = (props) => {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text fg={currentTheme.color('textStrong')} attributes={currentTheme.attributes('bold')} wrapMode="word">
        {props.title}
      </Text>
      {props.detail !== undefined && props.detail.length > 0 ? (
        <Text fg={currentTheme.color('textDim')} wrapMode="word">
          {props.detail}
        </Text>
      ) : null}
    </Box>
  )
}
