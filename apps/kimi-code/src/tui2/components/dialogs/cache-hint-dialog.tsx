/** @jsxImportSource @opentui/solid */
/**
 * TUI2 cache hint dialog — shown when a resumed (or long-idle) session's
 * context cache has almost certainly expired, so the next turn re-sends
 * the whole history uncached. Offers compact / new / continue / never.
 *
 * Replaces the v1 `CacheHintDialogComponent` (a pi-tui `Container`
 * subclass) with an opentui SolidJS view. Layout mirrors DESIGN.md:
 * top border, formatted title, hint, blank, "expired" body line, list
 * rows with right-column descriptions, bottom border. No search, no
 * current marker.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { formatIdleDuration } from '../../utils/cache-hint'
import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { formatTokenCount } from '../../../utils/usage/usage-format'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type CacheHintAction = 'compact' | 'new' | 'continue' | 'never'

interface CacheHintOption {
  readonly value: CacheHintAction
  readonly label: string
  readonly description?: string
}

const CACHE_HINT_OPTIONS: readonly CacheHintOption[] = [
  {
    value: 'compact',
    label: t('tui.dialogs.cacheHint.compactLabel'),
    description: t('tui.dialogs.cacheHint.compactDesc'),
  },
  {
    value: 'new',
    label: t('tui.dialogs.cacheHint.newLabel'),
    description: t('tui.dialogs.cacheHint.newDesc'),
  },
  {
    value: 'continue',
    label: t('tui.dialogs.cacheHint.continueLabel'),
    description: t('tui.dialogs.cacheHint.continueDesc'),
  },
  { value: 'never', label: t('tui.dialogs.cacheHint.neverLabel') },
]

const MAX_LABEL_WIDTH = (() => {
  let max = 0
  for (const opt of CACHE_HINT_OPTIONS) {
    if (opt.label.length > max) max = opt.label.length
  }
  return max
})()

export interface CacheHintDialogProps {
  readonly idleSeconds: number
  readonly totalTokens: number
  readonly onSelect: (action: CacheHintAction) => void
  readonly onCancel: () => void
}

export const CacheHintDialog: Component<CacheHintDialogProps> = (props) => {
  const [cursor, setCursor] = createSignal(0)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(CACHE_HINT_OPTIONS.length - 1, c + 1))
        return
      case 'return':
      case 'enter': {
        const opt = CACHE_HINT_OPTIONS[cursor()]
        if (opt !== undefined) {
          event.stopPropagation()
          props.onSelect(opt.value)
        }
        return
      }
      default:
        return
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const titleText = (): string =>
    t('tui.dialogs.cacheHint.title', {
      idle: formatIdleDuration(props.idleSeconds),
      tokens: formatTokenCount(props.totalTokens),
    })
  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${titleText()}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${t('tui.dialogs.cacheHint.navHint')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Expired body line */}
      <Box>
        <Text fg={textFg()}>{t('tui.dialogs.cacheHint.expired')}</Text>
      </Box>
      {/* List rows */}
      <For each={CACHE_HINT_OPTIONS}>
        {(opt, i) => {
          const selected = (): boolean => i() === cursor()
          return (
            <Box flexDirection="row">
              <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
              <Text
                fg={selected() ? titleFg() : textFg()}
                attributes={selected() ? titleAttrs() : undefined}
              >
                {opt.label}
              </Text>
              <Show when={opt.description !== undefined}>
                <Text fg={hintFg()}>
                  {`${' '.repeat(Math.max(2, MAX_LABEL_WIDTH - opt.label.length + 2))}${opt.description}`}
                </Text>
              </Show>
            </Box>
          )
        }}
      </For>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}