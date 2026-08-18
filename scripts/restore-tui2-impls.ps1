$ErrorActionPreference = 'Stop'

$dir = 'G:\kimi\kimi-code\apps\kimi-code\src\tui2\components\common'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$files = @{
  'box.tsx'       = @'
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
  border?: boolean | string
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
'@

  'text.tsx'      = @'
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
  wrapMode?: 'word' | 'none' | 'char'
  onClick?: () => void
}

export const Text: ParentComponent<TextProps> = (props) => {
  const merged = props as TextProps & OpenTuiTextProps
  return <text {...merged}>{props.children}</text>
}
'@

  'spacer.tsx'    = @'
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
'@

  'clickable.tsx' = @'
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
      onMouseUp={handleMouseUp}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  )
}
'@

  'button.tsx'    = @'
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
'@
}

foreach ($name in $files.Keys) {
  $path = Join-Path $dir $name
  [System.IO.File]::WriteAllText($path, $files[$name], $utf8NoBom)
  Write-Host "wrote $path ($((Get-Item $path).Length) bytes)"
}

# Now also rewrite the .ts facades to point at the .tsx siblings
$facades = @{
  'clickable.ts' = "export * from './clickable.tsx'`r`n"
  'button.ts'    = "export * from './button.tsx'`r`n"
}
foreach ($name in $facades.Keys) {
  $path = Join-Path $dir $name
  [System.IO.File]::WriteAllText($path, $facades[$name], $utf8NoBom)
  Write-Host "wrote facade $path"
}
