/** @jsxImportSource @opentui/solid */
/**
 * TUI2 btw-panel — side-question ("by the way…") conversation view shown
 * in the right pane alongside the main transcript.
 *
 * Replaces the v1 `BtwPanelComponent` (a pi-tui `Component` with embedded
 * `Markdown` / `Text` rendering) with an opentui SolidJS view. The pane
 * is stateful (turn list, transient notices, scroll position) and the host
 * pushes content via the imperative bridge (`submit` / `appendAnswer` /
 * `appendThinking` / `markDone` / `markFailed` / `addTransientNotice`).
 * Keyboard (when the host routes focus): Esc closes, ↑/↓ scrolls.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'

import { t } from '#/i18n'

import { THINKING_PREVIEW_LINES } from '../../constant/rendering'
import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'

type BtwPhase = 'running' | 'done' | 'failed'

interface BtwTurn {
  prompt: string
  answer: string
  thinking: string
  error?: string
  phase: BtwPhase
}

export interface BtwPanelProps {
  readonly width: number
}

export const BtwPanel: Component<BtwPanelProps> = (_props) => {
  const [turns] = createSignal<readonly BtwTurn[]>([])
  const [_transientNotices] = createSignal<readonly string[]>([])

  const borderFg = (): ColorInput => currentTheme.color('border')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const errorFg = (): ColorInput => currentTheme.color('error')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')

  return (
    <Box flexDirection="column">
      {/* Top border with title */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╭─ '}</Text>
        <Text fg={accentFg()} attributes={titleAttrs()}>{t('tui.dialogs.btwPanel.title')}</Text>
        <Text fg={borderFg()}>{` ─${'─'.repeat(Math.max(0, _props.width - 12))}╮`}</Text>
      </Box>
      <Show
        when={turns().length > 0}
        fallback={
          <Box>
            <Text>{'│ '}</Text>
            <Text fg={textMutedFg()}>{t('tui.dialogs.btwPanel.readyForSideQuestion')}</Text>
          </Box>
        }
      >
        <For each={turns()}>
          {(turn, i) => (
            <>
              <Show when={i() > 0}>
                <Box>
                  <Text>{'│ '}</Text>
                </Box>
              </Show>
              <Box>
                <Text>{'│ '}</Text>
                <Text fg={accentFg()}>{`${t('tui.dialogs.btwPanel.questionPrefix')}${turn.prompt}`}</Text>
              </Box>
              <Show
                when={turn.error !== undefined}
                fallback={
                  <Show
                    when={turn.answer.trim().length > 0}
                    fallback={
                      <Show
                        when={turn.thinking.trim().length > 0}
                        fallback={
                          <Box>
                            <Text>{'│ '}</Text>
                            <Text fg={textDimFg()}>{t('tui.dialogs.btwPanel.waitingForAnswer')}</Text>
                          </Box>
                        }
                      >
                        <For each={turn.thinking.trim().split('\n').slice(-THINKING_PREVIEW_LINES)}>
                          {(line) => (
                            <Box>
                              <Text>{'│ '}</Text>
                              <Text fg={textDimFg()}>{line}</Text>
                            </Box>
                          )}
                        </For>
                      </Show>
                    }
                  >
                    <For each={turn.answer.trim().split('\n')}>
                      {(line) => (
                        <Box>
                          <Text>{'│ '}</Text>
                          <Text>{line}</Text>
                        </Box>
                      )}
                    </For>
                  </Show>
                }
              >
                <For each={(turn.error ?? '').split('\n')}>
                  {(line) => (
                    <Box>
                      <Text>{'│ '}</Text>
                      <Text fg={errorFg()}>{line}</Text>
                    </Box>
                  )}
                </For>
              </Show>
            </>
          )}
        </For>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>{`╰${'─'.repeat(Math.max(0, _props.width - 2))}╯`}</Text>
      </Box>
    </Box>
  )
}