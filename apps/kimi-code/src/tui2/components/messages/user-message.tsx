/** @jsxImportSource @opentui/solid */
/**
 * TUI2 user message view.
 *
 * Replaces `tui/components/messages/user-message.ts`'s
 * `UserMessageComponent` (a pi-tui `Component` rendering ANSI strings)
 * with an opentui SolidJS view:
 *
 *   ✨ <user text>
 *
 * The leading marker defaults to the `✨ ` user bullet and is bold
 * `roleUser` (v1's `boldFg('roleUser', marker)`); an empty `bullet`
 * suppresses it entirely (used by shell-command echoes so `$` replaces
 * the marker). The text wraps in the same roleUser hue.
 *
 * Image thumbnails (v1's `ImageThumbnail` children) are not rendered
 * yet: the tui2 media components (`components/media/image-thumbnail.ts`
 * is still a v1 re-export stub). `imageAttachmentIds` is accepted so the
 * entry data flows through and the media view can be slotted in when the
 * port lands.
 *
 * `ReplayTurnBoundaryComponent` (an invisible turn-boundary marker that
 * rendered zero lines in v1) becomes a SolidJS component rendering
 * nothing, keeping the exported name.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'

import { USER_MESSAGE_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface UserMessageViewProps {
  readonly content: string
  /** Override for the leading bullet; an empty string suppresses it. */
  readonly bullet?: string
  /** Image attachment ids for the user's pasted media (rendered once the tui2 media view lands). */
  readonly imageAttachmentIds?: readonly number[]
}

export const UserMessageView: Component<UserMessageViewProps> = (props) => {
  const marker = (): string => props.bullet ?? USER_MESSAGE_BULLET
  const attributes = (): number | undefined =>
    marker().length > 0 ? currentTheme.attributes('bold') : undefined

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Show when={marker().length > 0}>
          <Text fg={currentTheme.color('roleUser')} attributes={currentTheme.attributes('bold')}>
            {marker()}
          </Text>
        </Show>
        <Text fg={currentTheme.color('roleUser')} attributes={attributes()} wrapMode="word">
          {props.content}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Invisible turn-boundary marker for replay. Some replayed records start a
 * new turn without anything to show — the goal driver's synthetic
 * continuation prompt is model-facing and never rendered live — but the
 * transcript still needs a mounted boundary component so step/assistant
 * folding (and window trimming) can find the turn edges. Renders nothing.
 */
export const ReplayTurnBoundaryComponent: Component = () => null
