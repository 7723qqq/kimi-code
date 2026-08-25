/** @jsxImportSource @opentui/solid */
/**
 * TUI2 truncated tool output view.
 *
 * Replaces `tui/components/messages/tool-renderers/truncated.ts`'s
 * `TruncatedOutputComponent` (a pi-tui `Component` that capped *visual*
 * wrapped rows at `PREVIEW_LINES` via `Text.render(width)`) with an
 * opentui SolidJS view that caps *logical* lines — the layout engine
 * wraps the remaining content. The hint copy matches v1 exactly.
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

import { currentTheme, type ColorToken } from '../../../theme'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { buildTruncatedOutputLines, trimTrailingEmptyLines } from '../shell-execution'
import type { ResultRenderer } from './types'
import { PREVIEW_LINES } from './types'

export { trimTrailingEmptyLines }

export interface TruncatedOutputViewProps {
  readonly output: string
  readonly expanded?: boolean
  readonly isError?: boolean
  readonly maxLines?: number
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

export const TruncatedOutputView: Component<TruncatedOutputViewProps> = (props) => {
  const display = (): ReturnType<typeof buildTruncatedOutputLines> => {
    if (props.expanded === true) {
      return {
        lines: trimTrailingEmptyLines(props.output.split('\n')),
        hint: undefined,
      }
    }
    return buildTruncatedOutputLines(props.output, {
      maxLines: props.maxLines ?? PREVIEW_LINES,
      tail: props.tail ?? false,
      expandHint: props.expandHint ?? true,
    })
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
