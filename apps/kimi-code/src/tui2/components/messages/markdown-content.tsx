/** @jsxImportSource @opentui/solid */
/**
 * TUI2 shared markdown content view — opentui `<markdown>` wrapper.
 *
 * Shared by the assistant message view and the plan box so both get the
 * same markdown rendering (headings, lists, bold, inline code) without
 * duplicating the `SyntaxStyle` lifecycle. The syntax style is built once
 * at mount from the current palette and destroyed on unmount (opentui's
 * `SyntaxStyle` owns native resources); the markdown body color resolves
 * through `currentTheme` on every render, so a palette switch recolors
 * text without rebuilding the style.
 *
 * Status: REAL (tui2). Tui2-only helper (no v1 counterpart).
 */

import type { Component } from 'solid-js'
import { onCleanup } from 'solid-js'
import { SyntaxStyle } from '@opentui/core'
import type { ColorInput } from '@opentui/core'

import { markdownColors, markdownSyntaxTokens } from '../../theme'

export interface MarkdownContentViewProps {
  readonly content: string
  /** Keep the trailing markdown block unstable while content is still streaming. */
  readonly streaming?: boolean
  /** Override the default markdown body color (resolved from the theme otherwise). */
  readonly fg?: ColorInput
}

export const MarkdownContentView: Component<MarkdownContentViewProps> = (props) => {
  // SyntaxStyle is a snapshot over native theme resources — build once per
  // mount and release on unmount. Fg/bg stay theme-live via markdownColors().
  const syntaxStyle = SyntaxStyle.fromTheme(markdownSyntaxTokens())
  onCleanup(() => syntaxStyle.destroy())
  const colors = markdownColors()

  return (
    <markdown
      content={props.content}
      syntaxStyle={syntaxStyle}
      fg={props.fg ?? colors.fg}
      conceal={true}
      streaming={props.streaming === true}
    />
  )
}
