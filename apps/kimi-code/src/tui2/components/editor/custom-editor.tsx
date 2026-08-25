/** @jsxImportSource @opentui/solid */
/**
 * TUI2 custom editor — input box with app-level keybindings.
 *
 * Replaces the v1 `CustomEditor` (a pi-tui `Editor` subclass with 800+
 * lines of overrides for paste, history, leader-key, autocomplete,
 * file mentions, etc.) with an opentui SolidJS view built on opentui's
 * `<input>` renderable. Most of the per-key plumbing is delegated to
 * opentui's input handler (paste, history, cursor); app-level shortcuts
 * (Ctrl+G external editor, Ctrl+O tool output, Ctrl+S steer, etc.) and
 * the leader chord are consumed by the host keymap before reaching the
 * editor.
 *
 * Status: REAL (tui2, minimal). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'
import type { ColorInput } from '@opentui/core'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface CustomEditorProps {
  readonly placeholder?: string
  readonly width?: number
  readonly onSubmit?: (value: string) => void
  readonly onChange?: (value: string) => void
  readonly focused?: boolean
}

export const CustomEditor: Component<CustomEditorProps> = (props) => {
  const borderFg = (): ColorInput => currentTheme.color('borderFocus')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')

  return (
    <Box flexDirection="column">
      {/* Hint row */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.editor.label')} `}</Text>
        <Text fg={hintFg()}>{` ${t('tui.dialogs.editor.navHint')}`}</Text>
      </Box>
      {/* Input box */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╭'}</Text>
        <Text>{'─'.repeat(Math.max(1, (props.width ?? 40) - 2))}</Text>
        <Text fg={borderFg()}>{'╮'}</Text>
      </Box>
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '}</Text>
        <input
          focused={props.focused ?? true}
          placeholder={props.placeholder ?? t('tui.dialogs.editor.placeholder')}
          onInput={(v) => props.onChange?.(v)}
          onSubmit={(v) => {
            if (typeof v === 'string') props.onSubmit?.(v)
          }}
        />
        <Text>{' '}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╰'}</Text>
        <Text>{'─'.repeat(Math.max(1, (props.width ?? 40) - 2))}</Text>
        <Text fg={borderFg()}>{'╯'}</Text>
      </Box>
    </Box>
  )
}