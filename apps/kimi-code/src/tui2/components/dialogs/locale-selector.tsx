/** @jsxImportSource @opentui/solid */
/**
 * TUI2 locale selector — single-select between the built-in locales.
 *
 * Replaces the v1 `LocaleSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 * The locale union is narrow (en / zh) so the cast is safe; anything
 * unexpected is dropped on the v1 floor too.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'
import type { Locale } from '#/i18n'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

const LOCALE_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'en',
    label: t('tui.dialogs.localeSelector.enLabel'),
    description: t('tui.dialogs.localeSelector.enDesc'),
  },
  {
    value: 'zh',
    label: t('tui.dialogs.localeSelector.zhLabel'),
    description: t('tui.dialogs.localeSelector.zhDesc'),
  },
]

function isLocaleChoice(value: string): value is Locale {
  return value === 'en' || value === 'zh'
}

export interface LocaleSelectorProps {
  readonly currentValue: Locale
  readonly onSelect: (locale: Locale) => void
  readonly onCancel: () => void
}

export const LocaleSelector: Component<LocaleSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.localeSelector.title')}
    options={LOCALE_OPTIONS}
    currentValue={props.currentValue}
    onSelect={(value) => {
      if (isLocaleChoice(value)) props.onSelect(value)
    }}
    onCancel={props.onCancel}
  />
)