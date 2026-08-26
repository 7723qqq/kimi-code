/** @jsxImportSource @opentui/solid */
/**
 * Clickable -- declaratively clickable region.
 *
 * This is the v2 replacement for the `optionRows` Map<row, option>
 * pattern that v1 dialogs use to manually map a clicked y-coordinate
 * back to a choice. In v2, every Clickable is a real layout node,
 * so opentui's layout-engine hit-test routes the click directly
 * to it; no coordinate math, no row bookkeeping, no rebuild on
 * every render.
 *
 * Status: REAL (tui2). Replaces the v1 stub AND the dead v1
 * `Clickable` class in `tui/components/common/clickable.ts`.
 */

import type { ParentComponent } from 'solid-js'
import { createSignal } from 'solid-js'
import type { ColorInput } from '@opentui/core'

export interface ClickEvent {
  x: number
  y: number
}

export interface ClickableProps {
  onClick?: (event: ClickEvent) => void
  onHover?: (event: { hovered: boolean; x: number; y: number }) => void
  onMouseDown?: (event: ClickEvent) => void
  hoverBackgroundColor?: ColorInput
  backgroundColor?: ColorInput
  disabled?: boolean
  flexShrink?: number
  flexGrow?: number
  flexDirection?: 'row' | 'column'
}

export const Clickable: ParentComponent<ClickableProps> = (props) => {
  const [hovered, setHovered] = createSignal(false)

  const handleMouseOver = (event: ClickEvent) => {
    if (!hovered()) setHovered(true)
    props.onHover?.({ hovered: true, x: event.x, y: event.y })
  }

  const handleMouseOut = (event: ClickEvent) => {
    if (hovered()) setHovered(false)
    props.onHover?.({ hovered: false, x: event.x, y: event.y })
  }

  const handleMouseUp = (event: ClickEvent) => {
    if (props.disabled) return
    props.onClick?.(event)
  }

  return (
    <box
      backgroundColor={hovered() && !props.disabled && props.hoverBackgroundColor
        ? props.hoverBackgroundColor
        : props.backgroundColor}
      flexShrink={props.flexShrink}
      flexGrow={props.flexGrow}
      flexDirection={props.flexDirection}
      onMouseUp={handleMouseUp}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  )
}