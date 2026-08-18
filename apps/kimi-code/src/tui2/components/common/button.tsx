/** @jsxImportSource @opentui/solid */
/**
 * Button -- a labelled, clickable button.
 *
 * Replaces `tui/components/common/button.ts`'s `TuiButton`. Renders
 * as `[ Label ]` in the accent color, inverts on hover, fires
 * `onClick` on mouse-up anywhere inside the box. No manual
 * hit-testing -- opentui's layout tree routes the click.
 *
 * Status: REAL (tui2). Replaces the v1 stub AND the dead v1
 * `TuiButton` class.
 */

import type { Component } from 'solid-js'
import { createMemo } from 'solid-js'
import { RGBA } from '@opentui/core'
import type { ColorInput } from '@opentui/core'
import { Clickable } from './clickable'
import { Text } from './text'

export interface ButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
  accent?: ColorInput
  hoverFg?: ColorInput
}

const DEFAULT_ACCENT = RGBA.fromInts(120, 170, 255, 255)

export const Button: Component<ButtonProps> = (props) => {
  const text = () => `[ ${props.label} ]`
  const accent = () => props.accent ?? DEFAULT_ACCENT
  const fg = createMemo(() => (props.disabled ? '#666666' : accent()))

  return (
    <Clickable
      onClick={() => {
        if (!props.disabled) props.onClick()
      }}
      hoverBackgroundColor={accent()}
    >
      <Text fg={fg()}>{text()}</Text>
    </Clickable>
  )
}