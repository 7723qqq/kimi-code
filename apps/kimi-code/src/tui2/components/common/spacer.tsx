/** @jsxImportSource @opentui/solid */
/**
 * Spacer -- an empty layout slot.
 *
 * Replaces `pi-tui`'s `Spacer` (which inserted a single blank line)
 * with an opentui `<box>` that has zero intrinsic size.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

export interface SpacerProps {
  size?: number
  direction?: 'vertical' | 'horizontal'
}

export const Spacer: Component<SpacerProps> = (props) => {
  const direction = () => props.direction ?? 'vertical'
  const size = () => props.size ?? 1
  return (
    <box
      flexDirection={direction() === 'vertical' ? 'column' : 'row'}
      width={direction() === 'horizontal' ? size() : undefined}
      height={direction() === 'vertical' ? size() : undefined}
    />
  )
}