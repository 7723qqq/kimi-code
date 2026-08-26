/** @jsxImportSource @opentui/solid */
/**
 * TUI2 truncated tool output view.
 *
 * Replaces `tui/components/messages/tool-renderers/truncated.ts`'s
 * `TruncatedOutputComponent` (a pi-tui `Component` that capped *visual*
 * wrapped rows at `PREVIEW_LINES` via `Text.render(width)`) with an
 * opentui SolidJS view that matches that behavior: logical lines are
 * first folded into word-wrapped visual rows (`wrapToVisualRows`,
 * CJK/emoji width-aware) and the cap counts those rows, so a long
 * single-line JSON blob cannot flood the screen.
 *
 * Columns come from the `width` prop when provided, else the live
 * terminal width, else a conservative default (`resolvePreviewWidth`).
 *
 * The view self-pads with a two-cell left margin (mirroring the v1
 * `indent: 2`); the `renderTruncated` registry renderer feeds it from
 * tool results.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { currentTheme, type ColorToken } from '../../../theme'
import { resolvePreviewWidth, wrapToVisualRows } from '../../../utils/width'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { trimTrailingEmptyLines } from '../shell-execution'
import type { ResultRenderer } from './types'
import { PREVIEW_LINES } from './types'

export { trimTrailingEmptyLines }

/** Two-cell left margin rendered by the view's `paddingLeft`. */
const CONTENT_INDENT = 2

export interface TruncatedOutputViewProps {
  readonly output: string
  readonly expanded?: boolean
  readonly isError?: boolean
  readonly maxLines?: number
  /** Terminal columns available to the view; defaults to the live terminal
   * width via `resolvePreviewWidth` when omitted. Collapsed rendering folds
   * logical lines into visual rows against this budget minus the two-cell
   * left padding before capping. */
  readonly width?: number
  /** Foreground token for successful (non-error) output. Defaults to
   * `textDim`; Bash passes `textMuted` so its result sits one shade below
   * the `textDim` command. Error output always uses `error`. */
  readonly color?: ColorToken
  /** When false, the truncation footer omits the "ctrl+o to expand" promise
   * (for contexts whose output is fixed-truncated and never expands). */
  readonly expandHint?: boolean
  /** When true, collapsed rendering keeps the latest rows instead of the
   * first rows — useful for live output from a running command. */
  readonly tail?: boolean
}

/** Folded visual rows plus how many of them the cap hides. */
export interface VisualTruncatedRows {
  readonly rows: readonly string[]
  readonly hidden: number
}

/**
 * Fold output into visual rows (`wrapToVisualRows`, so CJK/emoji width is
 * respected) and cap at `maxLines` of them — head first, or the latest
 * rows when `tail`. `width` is the content budget after left padding.
 */
export function buildVisualTruncatedRows(
  output: string,
  options: { maxLines: number; width: number; tail: boolean },
): VisualTruncatedRows {
  const rows: string[] = []
  for (const line of trimTrailingEmptyLines(output.split('\n'))) {
    rows.push(...wrapToVisualRows(line, options.width))
  }
  if (rows.length <= options.maxLines) return { rows, hidden: 0 }
  const shown = options.tail
    ? rows.slice(rows.length - options.maxLines)
    : rows.slice(0, options.maxLines)
  return { rows: shown, hidden: rows.length - options.maxLines }
}

export const TruncatedOutputView: Component<TruncatedOutputViewProps> = (props) => {
  const display = (): { lines: readonly string[]; hint: string | undefined } => {
    if (props.expanded === true) {
      return {
        lines: trimTrailingEmptyLines(props.output.split('\n')),
        hint: undefined,
      }
    }
    const tail = props.tail ?? false
    const width = Math.max(1, resolvePreviewWidth(props.width) - CONTENT_INDENT)
    const { rows, hidden } = buildVisualTruncatedRows(props.output, {
      maxLines: props.maxLines ?? PREVIEW_LINES,
      width,
      tail,
    })
    if (hidden === 0) return { lines: rows, hint: undefined }
    const hint = tail
      ? t('tui.statusMessages.truncatedEarlierLines', { remaining: String(hidden) })
      : (props.expandHint ?? true)
        ? t('tui.statusMessages.truncatedMoreLinesExpandable', { remaining: String(hidden) })
        : t('tui.statusMessages.truncatedMoreLines', { remaining: String(hidden) })
    return { lines: rows, hint }
  }
  const fg = (): ColorInput =>
    props.isError === true ? currentTheme.color('error') : currentTheme.color(props.color ?? 'textDim')

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <For each={display().lines}>
        {(line) => (
          <Text fg={fg()} wrapMode="word">
            {line}
          </Text>
        )}
      </For>
      <Show when={display().hint !== undefined}>
        <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
          {display().hint}
        </Text>
      </Show>
    </Box>
  )
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => (
  <TruncatedOutputView output={result.output} expanded={ctx.expanded} isError={result.is_error ?? false} />
)
