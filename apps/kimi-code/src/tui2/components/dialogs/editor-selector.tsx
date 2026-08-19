/** @jsxImportSource @opentui/solid */
/**
 * TUI2 external editor selector — VS Code / vim / nvim / nano / auto-detect.
 *
 * Replaces the v1 `EditorSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

const EDITOR_OPTIONS: readonly ChoiceOption[] = [
  { value: 'code --wait', label: t('tui.dialogs.editorSelector.vsCode') },
  { value: 'vim', label: t('tui.dialogs.editorSelector.vim') },
  { value: 'nvim', label: t('tui.dialogs.editorSelector.neovim') },
  { value: 'nano', label: t('tui.dialogs.editorSelector.nano') },
  { value: '', label: t('tui.dialogs.editorSelector.autoDetect') },
]

export interface EditorSelectorProps {
  readonly currentValue: string
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
}

export const EditorSelector: Component<EditorSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.editorSelector.title')}
    options={EDITOR_OPTIONS}
    currentValue={props.currentValue}
    onSelect={props.onSelect}
    onCancel={props.onCancel}
  />
)