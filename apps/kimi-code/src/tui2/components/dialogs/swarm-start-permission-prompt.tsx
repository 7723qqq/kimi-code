/** @jsxImportSource @opentui/solid */
/**
 * TUI2 swarm-start-permission prompt — thin wrapper around
 * `StartPermissionPrompt` for the swarm-start flow.
 *
 * Replaces the v1 `SwarmStartPermissionPromptComponent` (a
 * `StartPermissionPromptComponent` subclass) with a SolidJS wrapper.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { t } from '#/i18n'

import {
  StartPermissionPrompt,
  type StartPermissionChoice,
  type StartPermissionOption,
} from './start-permission-prompt'

export type SwarmStartPermissionChoice = Exclude<StartPermissionChoice, 'cancel'>

export interface SwarmStartPermissionPromptProps {
  readonly onSelect: (choice: SwarmStartPermissionChoice) => void
  readonly onCancel: () => void
}

const SWARM_OPTIONS: readonly StartPermissionOption<SwarmStartPermissionChoice>[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionAutoLabel'),
    description: t('tui.dialogs.swarmStartPermissionPrompt.optionAutoDesc'),
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionYoloLabel'),
    description: t('tui.dialogs.swarmStartPermissionPrompt.optionYoloDesc'),
  },
  {
    value: 'manual',
    label: t('tui.dialogs.swarmStartPermissionPrompt.optionManualLabel'),
    description: t('tui.dialogs.swarmStartPermissionPrompt.optionManualDesc'),
  },
]

const SWARM_NOTICE: readonly string[] = [
  t('tui.dialogs.swarmStartPermissionPrompt.notice1'),
  t('tui.dialogs.swarmStartPermissionPrompt.notice2'),
  t('tui.dialogs.swarmStartPermissionPrompt.notice3'),
]

export const SwarmStartPermissionPrompt = (
  props: SwarmStartPermissionPromptProps,
): unknown => (
  <StartPermissionPrompt
    title={t('tui.dialogs.swarmStartPermissionPrompt.title')}
    noticeLines={SWARM_NOTICE}
    options={SWARM_OPTIONS}
    onSelect={props.onSelect}
    onCancel={props.onCancel}
  />
)