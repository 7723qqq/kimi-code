/** @jsxImportSource @opentui/solid */
/**
 * TUI2 assistant message view — opentui Markdown.
 *
 * Replaces `tui/components/messages/assistant-message.ts`'s
 * `AssistantMessageComponent` (a pi-tui `Component` managing a Markdown
 * child with imperative `updateContent`) with an opentui SolidJS view:
 *
 *   ● markdown content…
 *
 * The content renders through opentui's `<markdown>` renderable (via
 * `MarkdownContentView`), so headings / lists / bold / inline code match
 * the v1 appearance. Streaming tail bounding is kept: while `transient`
 * is set, only the last `STREAMING_MARKDOWN_TAIL_CHARS` of the content
 * render, keeping the still-growing draft cheap to re-lex. The bullet
 * (`● `) mirrors v1's `STATUS_BULLET` prefix and is optional via
 * `showBullet`.
 *
 * Navigation-mode focus highlighting (accent background on the first
 * content row in v1) is intentionally left to the transcript renderer,
 * which owns the focused-entry state.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'

import { STREAMING_MARKDOWN_TAIL_CHARS } from '../../constant/streaming'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { MarkdownContentView } from './markdown-content'

export interface AssistantMessageViewProps {
  readonly content: string
  /** While streaming, render only a bounded tail so re-lexing stays O(tail). */
  readonly transient?: boolean
  /** Leading `● ` marker; defaults to true. */
  readonly showBullet?: boolean
}

export const AssistantMessageView: Component<AssistantMessageViewProps> = (props) => {
  const displayText = (): string => {
    const text = props.content.trim();
    if (props.transient === true && text.length > STREAMING_MARKDOWN_TAIL_CHARS) {
      return text.slice(-STREAMING_MARKDOWN_TAIL_CHARS);
    }
    return text;
  };

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Show when={props.showBullet !== false}>
          <Text fg={currentTheme.color('text')}>{STATUS_BULLET}</Text>
        </Show>
        <Box flexGrow={1}>
          <MarkdownContentView content={displayText()} streaming={props.transient === true} />
        </Box>
      </Box>
    </Box>
  )
}
