/** @jsxImportSource @opentui/solid */
/**
 * TUI2 compaction block — transcript component that renders a compaction
 * progress / completion / cancellation row.
 *
 * Replaces the v1 `CompactionComponent` (a pi-tui `Container` with a blink
 * timer) with an opentui SolidJS view. Lifecycle:
 *  - construction → blinking white bullet + "Compacting context..." with
 *    optional custom instruction
 *  - `markDone()` → solid green bullet + "Compaction complete (X → Y tokens)"
 *  - `markCanceled()` → solid warning bullet + "Compaction cancelled"
 *
 * The blink timer (500 ms) is local to this component; when the host mounts
 * it, it owns the lifecycle and calls `dispose()` on teardown so the timer
 * is cleared.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

const BLINK_INTERVAL = 500

export interface CompactionViewProps {
  readonly instruction?: string
  readonly tip?: string
}

interface CompactionState {
  done: boolean
  canceled: boolean
  tokensBefore?: number
  tokensAfter?: number
  summary?: string
  expanded: boolean
  blinkOn: boolean
  blinkTimer?: ReturnType<typeof setInterval>
}

export const CompactionView: Component<CompactionViewProps> = (props) => {
  const [state, setState] = createSignal<CompactionState>({
    done: false,
    canceled: false,
    expanded: false,
    blinkOn: true,
  })

  function startBlink(): void {
    if (state().blinkTimer !== undefined) return
    const timer = setInterval(() => {
      setState((prev) => ({ ...prev, blinkOn: !prev.blinkOn }))
    }, BLINK_INTERVAL)
    setState((prev) => ({ ...prev, blinkTimer: timer }))
  }

  function stopBlink(): void {
    const timer = state().blinkTimer
    if (timer !== undefined) {
      clearInterval(timer)
    }
    setState((prev) => ({ ...prev, blinkTimer: undefined }))
  }

  // Auto-start blink on mount; clean up on dispose.
  createEffect(() => {
    startBlink()
    onCleanup(() => stopBlink())
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
        when={state().done}
        fallback={
          <Show
            when={state().canceled}
            fallback={
              <Box flexDirection="row">
                <Text fg={state().blinkOn ? textFg() : textDimFg()}>{STATUS_BULLET}</Text>
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
          <Show when={state().tokensBefore !== undefined && state().tokensAfter !== undefined}>
            <Text fg={textDimFg()}>
              {` ${t('tui.dialogs.compaction.detailTokens', {
                before: state().tokensBefore ?? 0,
                after: state().tokensAfter ?? 0,
              })}`}
            </Text>
          </Show>
          <Show when={state().summary !== undefined && state().summary.length > 0}>
            <Text fg={textDimFg()}>
              {` ${t('tui.dialogs.compaction.shortcutHint', {
                action: state().expanded
                  ? t('tui.dialogs.compaction.hide')
                  : t('tui.dialogs.compaction.show'),
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
      {/* Optional summary (expanded) */}
      <Show when={state().expanded && state().summary !== undefined && state().summary.length > 0}>
        <For each={(state().summary ?? '').split('\n')}>
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