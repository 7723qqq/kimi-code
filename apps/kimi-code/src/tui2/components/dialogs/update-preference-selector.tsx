/** @jsxImportSource @opentui/solid */
/**
 * TUI2 update-notification preference selector — on / off.
 *
 * Replaces the v1 `UpdatePreferenceSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

const UPDATE_PREFERENCE_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: t('tui.dialogs.updatePreferenceSelector.on'),
    description: t('tui.dialogs.updatePreferenceSelector.onDescription'),
  },
  {
    value: 'off',
    label: t('tui.dialogs.updatePreferenceSelector.off'),
    description: t('tui.dialogs.updatePreferenceSelector.offDescription'),
  },
]

export interface UpdatePreferenceSelectorProps {
  readonly currentValue: boolean
  readonly onSelect: (value: boolean) => void
  readonly onCancel: () => void
}

export const UpdatePreferenceSelector: Component<UpdatePreferenceSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.updatePreferenceSelector.title')}
    options={UPDATE_PREFERENCE_OPTIONS}
    currentValue={props.currentValue ? 'on' : 'off'}
    onSelect={(value) => props.onSelect(value === 'on')}
    onCancel={props.onCancel}
  />
)