/** @jsxImportSource @opentui/solid */
/**
 * TUI2 platform selector — Kimi Code built-in + the OAuth open platforms
 * (filtered by the `xunfei_coding_plan` experimental flag for `astron`).
 *
 * Replaces the v1 `PlatformSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import { OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth'

import { t } from '#/i18n'

import { isExperimentalFlagEnabled } from '../../commands/experimental-flags'
import { ChoicePicker, type ChoiceOption } from './choice-picker'

function getPlatformOptions(): readonly ChoiceOption[] {
  return [
    { value: 'kimi-code', label: t('tui.dialogs.platformSelector.kimiCode') },
    ...OPEN_PLATFORMS.filter(
      (p) => p.id !== 'astron' || isExperimentalFlagEnabled('xunfei_coding_plan'),
    ).map((platform) => ({ value: platform.id, label: platform.name })),
  ]
}

export interface PlatformSelectorProps {
  readonly onSelect: (platformId: string) => void
  readonly onCancel: () => void
}

export const PlatformSelector: Component<PlatformSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.platformSelector.title')}
    options={getPlatformOptions()}
    onSelect={props.onSelect}
    onCancel={props.onCancel}
  />
)