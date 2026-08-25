/** @jsxImportSource @opentui/solid */
/**
 * Text -- a styled text run.
 *
 * Replaces `pi-tui`'s `Text` (which returned styled strings) with
 * an opentui `TextRenderable`. The opentui primitive owns its own
 * buffer cell, supports OSC 8 hyperlinks natively, and participates
 * in the layout tree.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { ParentComponent } from 'solid-js'
import type { TextProps as OpenTuiTextProps } from '@opentui/solid'
import type { ColorInput } from '@opentui/core'

export interface TextProps {
  fg?: ColorInput
  bg?: ColorInput
  attributes?: number
  width?: number | 'auto' | `${number}%`
  flexShrink?: number
  wrapMode?: 'word' | 'none' | 'char'
  truncate?: boolean
  onClick?: () => void
}

export const Text: ParentComponent<TextProps> = (props) => {
  const merged = props as TextProps & OpenTuiTextProps
  return <text {...merged}>{props.children}</text>
}