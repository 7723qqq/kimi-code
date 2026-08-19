/** @jsxImportSource @opentui/solid */
/**
 * TUI2 API key input dialog — rounded box that collects an API key for an
 * open platform provider.
 *
 * Replaces the v1 `ApiKeyInputDialogComponent` (a pi-tui `Container` with
 * an embedded `Input`) with an opentui SolidJS view that uses opentui's
 * `<input>` renderable. Geometry mirrors `FeedbackInputDialog` so the
 * chrome stays consistent across the input dialogs: rounded border, title
 * (bold), subtitle lines (dim, multiline), input line, footer.
 *
 * The `mask` option is accepted for API parity with v1 but not yet wired
 * up: opentui's `<input>` does not expose a "render masked" hook, so the
 * typed characters are shown verbatim. A follow-up can render bullets
 * from the captured `value` signal alongside the input.
 *
 * The host wires `Esc` / `Ctrl+C` / `Ctrl+D` to `onCancel` via the
 * dialog-level keymap layer.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type ApiKeyInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' }

export interface ApiKeyInputDialogProps {
  readonly platformName: string
  readonly subtitleLines: readonly string[]
  readonly onDone: (result: ApiKeyInputResult) => void
  readonly title?: string
  /** Accepted for API parity; not yet wired to masking. */
  readonly mask?: boolean
  readonly emptyHint?: string
}

const ROW_INNER_WIDTH = 36
const ROW_PADDING = 2

export const ApiKeyInputDialog: Component<ApiKeyInputDialogProps> = (props) => {
  const [value, setValue] = createSignal('')
  const [emptyHinted, setEmptyHinted] = createSignal(false)

  const titleText = (): string =>
    props.title ?? `Enter API key for ${props.platformName}`
  const subtitle = (): readonly string[] =>
    emptyHinted()
      ? [props.emptyHint ?? t('tui.dialogs.apiKeyInput.emptyHint')]
      : props.subtitleLines

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
          {titleText()}
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
      {/* Subtitle lines (multi-line) */}
      <For each={subtitle()}>
        {(line) => (
          <Box flexDirection="row">
            <Text fg={borderFg()}>{'│'}</Text>
            <Text>{' '.repeat(ROW_PADDING)}</Text>
            <Text fg={subtitleFg()}>{line}</Text>
            <Text>{' '.repeat(ROW_PADDING)}</Text>
            <Text fg={borderFg()}>{'│'}</Text>
          </Box>
        )}
      </For>
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
          placeholder={t('tui.dialogs.apiKeyInput.placeholder')}
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
        <Text fg={subtitleFg()}>{t('tui.dialogs.apiKeyInput.footer')}</Text>
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