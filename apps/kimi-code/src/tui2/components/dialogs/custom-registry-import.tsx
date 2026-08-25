/** @jsxImportSource @opentui/solid */
/**
 * TUI2 custom-registry import dialog — blue rounded box that collects a
 * custom registry URL and a Bearer token before importing the registry's
 * provider entries.
 *
 * Replaces the v1 `CustomRegistryImportDialogComponent` (a pi-tui
 * `Container` with two embedded `Input`s) with an opentui SolidJS view
 * that uses opentui's `<input>` renderable per field. Geometry mirrors
 * `ApiKeyInputDialog` so the chrome stays consistent across the input
 * dialogs.
 *
 * Tab / Shift+Tab / ↑ / ↓ switch fields; Enter advances (URL → token),
 * and submits on the last field. Both fields are required; an empty
 * field surfaces a sub-hint instead of closing the dialog. Esc / Ctrl+C /
 * Ctrl+D cancel. The `mask` behaviour for the token field is accepted
 * but not yet rendered as bullets (follow-up).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface CustomRegistryImportValue {
  readonly url: string
  readonly apiKey: string
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' }

export interface CustomRegistryImportDialogProps {
  readonly onDone: (result: CustomRegistryImportResult) => void
  readonly defaultUrl?: string
}

type FieldId = 'url' | 'token'

const ROW_INNER_WIDTH = 36
const ROW_PADDING = 2

export const CustomRegistryImportDialog: Component<CustomRegistryImportDialogProps> = (props) => {
  const [activeField, setActiveField] = createSignal<FieldId>('url')
  const [urlValue, setUrlValue] = createSignal(props.defaultUrl ?? '')
  const [tokenValue, setTokenValue] = createSignal('')
  const [hint, setHint] = createSignal<'none' | 'url-empty' | 'token-empty'>('none')

  function setField(field: FieldId): void {
    setHint('none')
    setActiveField(field)
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onDone({ kind: 'cancel' })
        return
      case 'tab':
      case 'backtab':
        event.stopPropagation()
        setField(activeField() === 'url' ? 'token' : 'url')
        return
      case 'up':
        event.stopPropagation()
        setField('url')
        return
      case 'down':
        event.stopPropagation()
        setField('token')
        return
      case 'return':
      case 'enter':
        event.stopPropagation()
        handleSubmit()
        return
      default:
        // Ctrl+C / Ctrl+D etc. are handled at the host keymap layer.
        return
    }
  }

  function handleSubmit(): void {
    const url = urlValue().trim()
    const token = tokenValue().trim()
    if (url.length === 0) {
      setHint('url-empty')
      setField('url')
      return
    }
    if (token.length === 0) {
      setHint('token-empty')
      setField('token')
      return
    }
    props.onDone({ kind: 'ok', value: { url, apiKey: token } })
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('textStrong')
  const subtitleFg = (): ColorInput => currentTheme.color('textDim')
  const inputFg = (): ColorInput => currentTheme.color('text')
  const accentFg = (): ColorInput => currentTheme.color('accent')
  const innerWidth = ROW_INNER_WIDTH + ROW_PADDING * 2
  const horizontalBorder = (glyph: string, n: number): string =>
    `${glyph}${glyph.repeat(n)}${glyph}`

  const subtitleText = (): string =>
    hint() === 'url-empty'
      ? t('tui.dialogs.customRegistryImport.subtitleUrlEmpty')
      : hint() === 'token-empty'
        ? t('tui.dialogs.customRegistryImport.subtitleTokenEmpty')
        : t('tui.dialogs.customRegistryImport.subtitleDefault')

  const footerText = (): string =>
    activeField() === 'url'
      ? t('tui.dialogs.customRegistryImport.footerNotLast')
      : t('tui.dialogs.customRegistryImport.footerLast')

  const urlLabelFg = (): ColorInput =>
    activeField() === 'url' ? accentFg() : subtitleFg()
  const tokenLabelFg = (): ColorInput =>
    activeField() === 'token' ? accentFg() : subtitleFg()

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
          {t('tui.dialogs.customRegistryImport.title')}
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
        <Text fg={subtitleFg()}>{subtitleText()}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Blank */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* URL label */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={urlLabelFg()} attributes={activeField() === 'url' ? currentTheme.attributes('bold') : undefined}>
          {t('tui.dialogs.customRegistryImport.urlLabel')}
        </Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* URL input */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Show
          when={activeField() === 'url'}
          fallback={<Text fg={inputFg()}>{urlValue()}</Text>}
        >
          <input
            
            focused
            placeholder={t('tui.dialogs.customRegistryImport.urlPlaceholder')}
            onInput={setUrlValue}
          />
        </Show>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Blank */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(innerWidth)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Token label */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={tokenLabelFg()} attributes={activeField() === 'token' ? currentTheme.attributes('bold') : undefined}>
          {t('tui.dialogs.customRegistryImport.tokenLabel')}
        </Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Token input (mask is not yet wired; value is shown verbatim) */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '.repeat(ROW_PADDING)}</Text>
        <Show
          when={activeField() === 'token'}
          fallback={<Text fg={inputFg()}>{tokenValue()}</Text>}
        >
          <input
            
            focused
            placeholder={t('tui.dialogs.customRegistryImport.tokenPlaceholder')}
            onInput={setTokenValue}
          />
        </Show>
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
        <Text fg={subtitleFg()}>{footerText()}</Text>
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