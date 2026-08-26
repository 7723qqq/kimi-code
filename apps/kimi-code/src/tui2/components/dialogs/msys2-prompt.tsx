/** @jsxImportSource @opentui/solid */
/**
 * TUI2 MSYS2 install prompt — install / skip.
 *
 * Replaces the v1 `Msys2PromptComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 * The custom hint copy (`tui.msys2Prompt.hint`) is forwarded as-is.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

export type Msys2PromptChoice = 'install' | 'skip'

const MSYS2_OPTIONS = (): readonly ChoiceOption[] => [
  {
    value: 'install',
    label: t('tui.dialogs.msys2Prompt.install'),
    description: t('tui.dialogs.msys2Prompt.installDescription'),
  },
  {
    value: 'skip',
    label: t('tui.dialogs.msys2Prompt.skip'),
    description: t('tui.dialogs.msys2Prompt.skipDescription'),
  },
]

export interface Msys2PromptProps {
  readonly onSelect: (choice: Msys2PromptChoice) => void
  readonly onCancel: () => void
}

export const Msys2Prompt: Component<Msys2PromptProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.msys2Prompt.title')}
    hint={t('tui.dialogs.msys2Prompt.hint')}
    options={MSYS2_OPTIONS()}
    onSelect={(value) => {
      props.onSelect(value as Msys2PromptChoice)
    }}
    onCancel={props.onCancel}
  />
)