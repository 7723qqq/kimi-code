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
 * The view mirrors v1's visual contract: a `> ` prompt token (matching the
 * pi-tui diagonal), the `! shell mode` badge + `!` prompt while a `!` shell
 * command is being composed, and border/title colouring driven by the host's
 * editor-border highlight state (plan/slash context) instead of a fixed
 * focus colour.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { useTui2Store } from '../../context'
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
  const store = useTui2Store()
  // Host-maintained editor border state (plan mode / slash context / shell
  // mode). `editorToken` maps to a theme colour token like v1's borderColor
  // hook; bash mode additionally shows the `!` prompt + shell-mode badge.
  const isBash = (): boolean => store.state.inputMode === 'bash'
  const borderToken = (): 'shellMode' | 'primary' | 'border' =>
    store.state.editorBorderHighlighted
      ? store.state.editorBorderToken
      : 'border'
  const borderFg = (): ColorInput => currentTheme.color(borderToken())
  const titleFg = (): ColorInput => currentTheme.color(borderToken())
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const promptFg = (): ColorInput =>
    isBash() ? currentTheme.color('shellMode') : currentTheme.color('text')
  const borderWidth = (): number => Math.max(1, (props.width ?? 40) - 2)
  const label = (): string =>
    isBash() ? t('tui.messages.shellModeLabel') : t('tui.dialogs.editor.label')

  return (
    <Box flexDirection="column" width="100%">
      {/* Label row */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${label()} `}</Text>
        <Text fg={hintFg()}>{` ${t('tui.dialogs.editor.navHint')}`}</Text>
      </Box>
      {/* Top border */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╭'}</Text>
        <Text fg={borderFg()}>{'─'.repeat(borderWidth())}</Text>
        <Text fg={borderFg()}>{'╮'}</Text>
      </Box>
      {/* Input row: prompt symbol + input */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '}</Text>
        <Text fg={promptFg()}>{isBash() ? '!' : '>'}</Text>
        <Text>{' '}</Text>
        <input
          flexGrow={1}
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
      {/* Bottom border */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╰'}</Text>
        <Text fg={borderFg()}>{'─'.repeat(borderWidth())}</Text>
        <Text fg={borderFg()}>{'╯'}</Text>
      </Box>
    </Box>
  )
}