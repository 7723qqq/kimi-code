/** @jsxImportSource @opentui/solid */
/**
 * Banner -- a highlighted notice shown above the transcript.
 *
 * Replaces `tui/components/chrome/banner.ts`'s `BannerComponent`. The v1
 * implementation was a pi-tui `Component` whose `render(width)` returned
 * ANSI strings; this is an opentui SolidJS component that returns a layout
 * tree. Layout, wrapping and colouring are handled by opentui primitives and
 * the shared `currentTheme` singleton.
 *
 * The component mirrors the v1 visual contract:
 *   - an optional inline tag (`✦ <tag>`), bold primary;
 *   - a bold `mainText`;
 *   - an optional dim `subText`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { currentTheme } from '../../theme'
import type { BannerState } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface BannerProps {
  readonly state: BannerState
}

const TAG_PREFIX = '✦ '

export const BannerComponent: Component<BannerProps> = (props) => {
  const tag = (): string => props.state.tag ?? ''
  const main = (): string => props.state.mainText
  const sub = (): string | null => props.state.subText

  const tagText = (): string =>
    tag().length > 0 ? `${TAG_PREFIX}${tag()}` : ''

  const tagFg = (): ColorInput => currentTheme.color('primary')
  const mainFg = (): ColorInput => currentTheme.color('textStrong')
  const subFg = (): ColorInput => currentTheme.color('textDim')

  return (
    <Box flexDirection="column">
      <Show when={tagText().length > 0}>
        <Text fg={tagFg()} attributes={currentTheme.attributes('bold')}>
          {tagText()}
        </Text>
      </Show>
      <Text fg={mainFg()} attributes={currentTheme.attributes('bold')} wrapMode="word">
        {main()}
      </Text>
      <Show when={sub() !== null && sub() !== ''}>
        <Text fg={subFg()} wrapMode="word">
          {sub()}
        </Text>
      </Show>
    </Box>
  )
}
