/** @jsxImportSource @opentui/solid */
/**
 * Box -- a layout container backed by opentui's Yoga flexbox.
 *
 * Replaces `pi-tui`'s `Container` / `VStack` / `HStack` / `Spacer`
 * trio. Pass-through to opentui's `<box>`, restricted to a curated
 * set of props that maps cleanly to the v1 TUI vocabulary. Extra
 * opentui-specific props are available via prop spread; this wrapper
 * is the v1-shaped surface, not the full opentui box surface.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { ParentComponent } from 'solid-js'
import type { BoxProps as OpenTuiBoxProps } from '@opentui/solid'
import type { ColorInput } from '@opentui/core'

/** Public prop surface -- the props kimi-code's dialogs use. */
export interface BoxProps {
  flexDirection?: 'row' | 'column'
  flexGrow?: number
  flexShrink?: number
  width?: number | string
  height?: number | string
  minHeight?: number
  maxHeight?: number
  padding?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  gap?: number | string
  backgroundColor?: ColorInput
  border?: boolean | string | ('top' | 'right' | 'bottom' | 'left')[]
  borderStyle?: 'single' | 'double' | 'rounded' | 'heavy'
  borderColor?: ColorInput
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between'
  focusable?: boolean
  focused?: boolean
  onMouseUp?: (event: { x: number; y: number }) => void
  onMouseOver?: (event: { x: number; y: number }) => void
  onMouseOut?: (event: { x: number; y: number }) => void
}

export const Box: ParentComponent<BoxProps> = (props) => {
  const merged = props as BoxProps & OpenTuiBoxProps
  return <box {...merged}>{props.children}</box>
}