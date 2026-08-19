/** @jsxImportSource @opentui/solid */
/**
 * TUI2 settings selector — menu of sub-settings reachable from `/settings`.
 *
 * Replaces the v1 `SettingsSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 * The "astron" entry is gated behind the same experimental flag as the
 * /login Astron platform option, matching v1.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { isExperimentalFlagEnabled } from '../../commands/experimental-flags'
import { ChoicePicker, type ChoiceOption } from './choice-picker'

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'editor'
  | 'language'
  | 'permission'
  | 'experiments'
  | 'upgrade'
  | 'usage'
  | 'github_token'
  | 'astron'

function getSettingsOptions(): readonly ChoiceOption[] {
  const options: ChoiceOption[] = [
    {
      value: 'model',
      label: t('tui.dialogs.settingsSelector.model'),
      description: t('tui.dialogs.settingsSelector.modelDesc'),
    },
    {
      value: 'permission',
      label: t('tui.dialogs.settingsSelector.permission'),
      description: t('tui.dialogs.settingsSelector.permissionDesc'),
    },
    {
      value: 'theme',
      label: t('tui.dialogs.settingsSelector.theme'),
      description: t('tui.dialogs.settingsSelector.themeDesc'),
    },
    {
      value: 'language',
      label: t('tui.dialogs.settingsSelector.language'),
      description: t('tui.dialogs.settingsSelector.languageDesc'),
    },
    {
      value: 'editor',
      label: t('tui.dialogs.settingsSelector.editor'),
      description: t('tui.dialogs.settingsSelector.editorDesc'),
    },
    {
      value: 'experiments',
      label: t('tui.dialogs.settingsSelector.experiments'),
      description: t('tui.dialogs.settingsSelector.experimentsDesc'),
    },
    {
      value: 'upgrade',
      label: t('tui.dialogs.settingsSelector.upgrade'),
      description: t('tui.dialogs.settingsSelector.upgradeDesc'),
    },
    {
      value: 'usage',
      label: t('tui.dialogs.settingsSelector.usage'),
      description: t('tui.dialogs.settingsSelector.usageDesc'),
    },
    {
      value: 'github_token',
      label: t('tui.dialogs.settingsSelector.githubToken'),
      description: t('tui.dialogs.settingsSelector.githubTokenDesc'),
    },
  ]
  if (isExperimentalFlagEnabled('xunfei_coding_plan')) {
    options.push({
      value: 'astron',
      label: t('tui.dialogs.settingsSelector.astron'),
      description: t('tui.dialogs.settingsSelector.astronDesc'),
    })
  }
  return options
}

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'theme' ||
    value === 'language' ||
    value === 'editor' ||
    value === 'permission' ||
    value === 'experiments' ||
    value === 'upgrade' ||
    value === 'usage' ||
    value === 'github_token' ||
    value === 'astron'
  )
}

export interface SettingsSelectorProps {
  readonly onSelect: (value: SettingsSelection) => void
  readonly onCancel: () => void
}

export const SettingsSelector: Component<SettingsSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.settingsSelector.title')}
    options={getSettingsOptions()}
    onSelect={(value) => {
      if (isSettingsSelection(value)) props.onSelect(value)
    }}
    onCancel={props.onCancel}
  />
)