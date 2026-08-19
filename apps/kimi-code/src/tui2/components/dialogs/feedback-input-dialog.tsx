/** @jsxImportSource @opentui/solid */
/**
 * TUI2 feedback input dialog — rounded box that collects a single line of
 * user feedback before submitting it to the managed Kimi Code platform.
 *
 * Replaces the v1 `FeedbackInputDialogComponent` (a pi-tui `Container`
 * with an embedded `Input`) with an opentui SolidJS view that uses
 * opentui's `<input>` renderable for the text entry. Geometry mirrors
 * `DeviceCodeBox` so the chrome stays consistent with the OAuth login
 * flow: rounded border, title (bold), subtitle (dim), input line, footer.
 *
 * The host wires `Esc` / `Ctrl+C` / `Ctrl+D` to `onCancel` via the
 * dialog-level keymap layer (the input consumes character keys only).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type FeedbackInputDialogResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' }

export interface FeedbackInputDialogProps {
  /** Submit / cancel callbacks. The host wires `Esc` / `Ctrl+C` / `Ctrl+D`
   * to `onCancel` via the dialog-level keymap layer. */
  readonly onDone: (result: FeedbackInputDialogResult) => void
}

const ROW_INNER_WIDTH = 36
const ROW_PADDING = 2

export const FeedbackInputDialog: Component<FeedbackInputDialogProps> = (props) => {
  const [value, setValue] = createSignal('')
  const [emptyHinted, setEmptyHinted] = createSignal(false)

  function submit(): void {
    const trimmed = value().trim()
    if (trimmed.length === 0) {
      setEmptyHinted(true)
      return
    }
    props.onDone({ kind: 'ok', value: trimmed })
  }

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('textStrong')
  const subtitleFg = (): ColorInput => currentTheme.color('textDim')
  const inputFg = (): ColorInput => currentTheme.color('text')
  const innerWidth = ROW_INNER_WIDTH + ROW_PADDING * 2
  const horizontalBorder = (glyph: string, n: number): string =>
    `${glyph}${glyph.repeat(n)}${glyph}`

  return (
    <Box flexDirection="column">
      {/* Blank above */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Top border — rounded */}
      <Box>
        <Text fg={borderFg()}>{horizontalBorder('─', innerWidth - 1)}</Text>
      </Box>
      {/* Empty padding row */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Title */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={titleFg()} attributes={currentTheme.attributes('bold')}>
          {t('tui.dialogs.feedbackInput.title')}
        </Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Blank */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Subtitle */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={subtitleFg()}>
          {emptyHinted()
            ? t('tui.dialogs.feedbackInput.subtitleEmpty')
            : t('tui.dialogs.feedbackInput.subtitleDefault')}
        </Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Blank */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Input line */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <input
          fg={inputFg()}
          focused
          placeholder={t('tui.dialogs.feedbackInput.placeholder')}
          onInput={setValue}
          onSubmit={submit}
        />
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Blank */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Footer */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={subtitleFg()}>{t('tui.dialogs.feedbackInput.footer')}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Empty padding row */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Bottom border — rounded */}
      <Box>
        <Text fg={borderFg()}>{horizontalBorder('─', innerWidth - 1)}</Text>
      </Box>
      {/* Blank below */}
      <Box>
        <Text>{''}</Text>
      </Box>
    </Box>
  )
}