/** @jsxImportSource @opentui/solid */
/**
 * TUI2 theme selector — built-in (auto / dark / light) + custom themes
 * discovered by `listCustomThemesSync()`.
 *
 * Replaces the v1 `ThemeSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 * The custom-theme list is captured at construction; subsequent reloads
 * require a remount (matching v1 behaviour — the dialog is a snapshot
 * taken at open time).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import type { ThemeName } from '../../theme'
import { listCustomThemesSync } from '../../theme/custom-theme-loader'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

function getBuiltinThemeOptions(): readonly ChoiceOption[] {
  return [
    { value: 'auto', label: t('tui.dialogs.themeSelector.auto') },
    { value: 'dark', label: t('tui.dialogs.themeSelector.dark') },
    { value: 'light', label: t('tui.dialogs.themeSelector.light') },
  ]
}

export interface ThemeSelectorProps {
  readonly currentValue: ThemeName
  readonly onSelect: (theme: ThemeName) => void
  readonly onCancel: () => void
}

export const ThemeSelector: Component<ThemeSelectorProps> = (props) => {
  const customThemes = listCustomThemesSync()
  const options: readonly ChoiceOption[] = [
    ...getBuiltinThemeOptions(),
    ...customThemes.map((name) => ({
      value: name,
      label: t('tui.dialogs.themeSelector.custom', { name }),
    })),
  ]

  return (
    <ChoicePicker
      title={t('tui.dialogs.themeSelector.title')}
      options={options}
      currentValue={props.currentValue}
      onSelect={(value) => props.onSelect(value as ThemeName)}
      onCancel={props.onCancel}
    />
  )
}