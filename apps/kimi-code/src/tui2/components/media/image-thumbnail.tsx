/** @jsxImportSource @opentui/solid */
/**
 * TUI2 image thumbnail — transcript-side rendering of a pasted image.
 *
 * Replaces the v1 `ImageThumbnail` (a pi-tui `Container` with an embedded
 * `Image`) with an opentui SolidJS view that uses opentui's `<image>`
 * renderable directly. On terminals that don't speak the Kitty / iTerm2
 * inline-image protocols (detected by `getCapabilities()`), the view
 * falls back to the one-line placeholder text the user already saw in the
 * input box — this keeps the transcript readable on Terminal.app /
 * Linux default terminals / `script` recordings without extra chrome.
 *
 * Height is capped at 12 rows and width at 40 columns so a single
 * screenshot can't monopolise the viewport; opentui handles the
 * proportional scaling inside the layout tree.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'

import { getCapabilities } from '@moonshot-ai/pi-tui'

import { currentTheme } from '../../theme'
import type { ImageAttachment } from '../../../tui/utils/image-attachment-store'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'

const MAX_IMAGE_WIDTH = 40

export interface ImageThumbnailProps {
  readonly attachment: ImageAttachment
  readonly width: number
}

export const ImageThumbnail: Component<ImageThumbnailProps> = (props) => {
  const supportsInline = (): boolean => {
    const caps = getCapabilities()
    return caps.images === 'kitty' || caps.images === 'iterm2'
  }
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const hasRoom = (): boolean => props.width >= MAX_IMAGE_WIDTH + 2

  return (
    <Box>
      <Show
        when={supportsInline() && hasRoom()}
        fallback={
          <Text fg={accentFg()}>{props.attachment.placeholder}</Text>
        }
      >
        <image
          source={`data:${props.attachment.mime};base64,${Buffer.from(props.attachment.bytes).toString('base64')}`}
          fit="fit"
        />
      </Show>
    </Box>
  )
}