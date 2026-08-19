/** @jsxImportSource @opentui/solid */
/**
 * TUI2 prefixed wrapped line — a text block with a prefix on the first
 * line and a continuation prefix on subsequent lines.
 *
 * Replaces `tui/components/messages/tool-call/prefixed-wrapped-line.ts`'s
 * `PrefixedWrappedLine` pi-tui Component (which wrapped against a pixel
 * width and cached rows) with an opentui SolidJS view. Wrapping is
 * delegated to `<Text wrapMode="word">`; the `tailLines` / `minLines`
 * caps count *logical* lines, mirroring the other tui2 views (v1 capped
 * visual wrapped rows, which the opentui layout tree does not expose
 * synchronously).
 *
 * Used by the single-subagent card window (`  │ …` gutter rows).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { Box } from '../../common/box'
import { Text } from '../../common/text'

export interface PrefixedWrappedLineProps {
  readonly firstPrefix: string
  readonly continuationPrefix: string
  readonly text: string
  /** Keep only the last `tailLines` logical lines (undefined = all). */
  readonly tailLines?: number
  /** Pad with empty lines up to `minLines` logical lines. */
  readonly minLines?: number
  readonly fg?: ColorInput
  readonly attributes?: number
}

export const PrefixedWrappedLine: Component<PrefixedWrappedLineProps> = (props) => {
  const lines = (): string[] => {
    let all = props.text.split('\n')
    if (props.tailLines !== undefined && all.length > props.tailLines) {
      all = all.slice(all.length - props.tailLines)
    }
    const result = [...all]
    if (props.minLines !== undefined) {
      while (result.length < props.minLines) result.push('')
    }
    return result
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <For each={lines()}>
        {(line, i) => (
          <Text fg={props.fg} attributes={props.attributes} wrapMode="word">
            {i() === 0 ? `${props.firstPrefix}${line}` : `${props.continuationPrefix}${line}`}
          </Text>
        )}
      </For>
    </Box>
  )
}
