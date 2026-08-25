/** @jsxImportSource @opentui/solid */
/**
 * TUI2 permission mode selector — manual / auto / yolo.
 *
 * Replaces the v1 `PermissionSelectorComponent` (a `ChoicePickerComponent`
 * subclass) with a thin SolidJS wrapper around the tui2 `ChoicePicker`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'

import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { ChoicePicker, type ChoiceOption } from './choice-picker'

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: t('tui.dialogs.permissionSelector.manual'),
    description: t('tui.dialogs.permissionSelector.manualDesc'),
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.permissionSelector.yolo'),
    description: t('tui.dialogs.permissionSelector.yoloDesc'),
  },
  {
    value: 'auto',
    label: t('tui.dialogs.permissionSelector.auto'),
    description: t('tui.dialogs.permissionSelector.autoDesc'),
  },
]

function isPermissionModeChoice(value: string): value is PermissionMode {
  return value === 'manual' || value === 'auto' || value === 'yolo'
}

export interface PermissionSelectorProps {
  readonly currentValue: PermissionMode
  readonly onSelect: (mode: PermissionMode) => void
  readonly onCancel: () => void
}

export const PermissionSelector: Component<PermissionSelectorProps> = (props) => (
  <ChoicePicker
    title={t('tui.dialogs.permissionSelector.title')}
    options={PERMISSION_OPTIONS}
    currentValue={props.currentValue}
    onSelect={(value) => {
      if (isPermissionModeChoice(value)) props.onSelect(value)
    }}
    onCancel={props.onCancel}
  />
)