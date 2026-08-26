/** @jsxImportSource @opentui/solid */
/**
 * TUI2 compaction block — transcript component that renders a compaction
 * progress / completion / cancellation row.
 *
 * Replaces the v1 `CompactionComponent` (a pi-tui `Container` with a blink
 * timer) with an opentui SolidJS view. The transcript entry's
 * `compactionData` drives the phase (see `compactionViewPropsFromData`):
 *
 *  - no result/tokens yet → blinking white bullet + "Compacting context..."
 *    with the optional custom instruction and working tip
 *  - `tokensBefore`/`tokensAfter` present → solid green bullet +
 *    "Compaction complete (X → Y tokens)"
 *  - `result: 'cancelled'` → solid warning bullet + "Compaction cancelled"
 *
 * The blink timer (500 ms) runs only while the block is in the compacting
 * phase and is disposed with the component.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { STATUS_BULLET } from '../../constant/symbols'
import type { CompactionTranscriptData } from '../../types'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

const BLINK_INTERVAL = 500

export interface CompactionViewProps {
  readonly instruction?: string
  /** Working tip shown while the compaction is still running. */
  readonly tip?: string
  readonly canceled?: boolean
  readonly done?: boolean
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly summary?: string
  /** Render the finished compaction's summary body (entry `expanded` flag). */
  readonly expanded?: boolean
}

/**
 * Map a transcript entry's `compactionData` onto `CompactionView` props.
 *
 * While the compaction runs, `summary` carries the working tip; once it
 * finishes, `tokensBefore`/`tokensAfter` mark the done phase and `summary`
 * becomes the (expandable) compaction summary.
 */
export function compactionViewPropsFromData(data: CompactionTranscriptData): CompactionViewProps {
  if (data.result === 'cancelled') {
    return { canceled: true, instruction: data.instruction };
  }
  if (data.tokensBefore !== undefined || data.tokensAfter !== undefined) {
    return {
      done: true,
      tokensBefore: data.tokensBefore,
      tokensAfter: data.tokensAfter,
      summary: data.summary,
      instruction: data.instruction,
    };
  }
  // Still compacting: surface the working tip, if any.
  return { tip: data.summary, instruction: data.instruction };
}

export const CompactionView: Component<CompactionViewProps> = (props) => {
  const [blinkOn, setBlinkOn] = createSignal(true)

  createEffect(() => {
    if (props.done === true || props.canceled === true) return
    const timer = setInterval(() => setBlinkOn((v) => !v), BLINK_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const successFg = (): ColorInput => currentTheme.color('success')
  const warningFg = (): ColorInput => currentTheme.color('warning')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const titleFg = (): ColorInput => currentTheme.color('primary')

  return (
    <Box flexDirection="column">
      {/* Top margin */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Header */}
      <Show
        when={props.done === true}
        fallback={
          <Show
            when={props.canceled === true}
            fallback={
              <Box flexDirection="row">
                <Text fg={blinkOn() ? textFg() : textDimFg()}>{STATUS_BULLET}</Text>
                <Text fg={titleFg()} attributes={currentTheme.attributes('bold')}>
                  {` ${t('tui.dialogs.compaction.compacting')}`}
                </Text>
                <Show when={props.tip !== undefined && props.tip.length > 0}>
                  <Text fg={textDimFg()}>{` ${t('tui.dialogs.compaction.tipPrefix', { tip: props.tip ?? '' })}`}</Text>
                </Show>
              </Box>
            }
          >
            <Box flexDirection="row">
              <Text fg={warningFg()}>{STATUS_BULLET}</Text>
              <Text fg={warningFg()} attributes={currentTheme.attributes('bold')}>
                {` ${t('tui.dialogs.compaction.cancelled')}`}
              </Text>
            </Box>
          </Show>
        }
      >
        <Box flexDirection="row">
          <Text fg={successFg()}>{STATUS_BULLET}</Text>
          <Text fg={successFg()} attributes={currentTheme.attributes('bold')}>
            {` ${t('tui.dialogs.compaction.complete')}`}
          </Text>
          <Show when={props.tokensBefore !== undefined && props.tokensAfter !== undefined}>
            <Text fg={textDimFg()}>
              {` ${t('tui.dialogs.compaction.detailTokens', {
                before: props.tokensBefore ?? 0,
                after: props.tokensAfter ?? 0,
              })}`}
            </Text>
          </Show>
        </Box>
      </Show>
      {/* Optional instruction */}
      <Show when={props.instruction !== undefined && props.instruction.length > 0}>
        <Box>
          <Text fg={textDimFg()}>{`  ${props.instruction ?? ''}`}</Text>
        </Box>
      </Show>
      {/* Summary body (done + expanded entry flag) */}
      <Show when={props.done === true && props.expanded === true && (props.summary ?? '').length > 0}>
        <For each={(props.summary ?? '').split('\n')}>
          {(line) => (
            <Box>
              <Text fg={textDimFg()}>{`  ${line}`}</Text>
            </Box>
          )}
        </For>
      </Show>
    </Box>
  )
}
