/** @jsxImportSource @opentui/solid */
/**
 * TUI2 goal-start-permission prompt — thin wrapper around
 * `StartPermissionPrompt` for the goal-start flow.
 *
 * Replaces the v1 `GoalStartPermissionPromptComponent` (a
 * `StartPermissionPromptComponent` subclass) with a SolidJS wrapper that
 * composes the shared `StartPermissionPrompt` with goal-start specific
 * title / notice / options. The "yolo" mode drops the manual option.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { t } from '#/i18n'

import {
  StartPermissionPrompt,
  type StartPermissionChoice,
  type StartPermissionOption,
} from './start-permission-prompt'

export type GoalStartPermissionChoice = StartPermissionChoice

export interface GoalStartPermissionPromptProps {
  readonly mode: 'manual' | 'yolo'
  readonly onSelect: (choice: GoalStartPermissionChoice) => void
  readonly onCancel: () => void
}

const MANUAL_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionAutoDesc'),
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionYoloDesc'),
  },
  {
    value: 'manual',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionManualLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionManualDesc'),
  },
  {
    value: 'cancel',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
  },
]

const YOLO_OPTIONS: readonly StartPermissionOption[] = [
  {
    value: 'auto',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionAutoLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionAutoDesc'),
  },
  {
    value: 'yolo',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionYoloKeepLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionYoloKeepDesc'),
  },
  {
    value: 'cancel',
    label: t('tui.dialogs.goalStartPermissionPrompt.optionCancelLabel'),
    description: t('tui.dialogs.goalStartPermissionPrompt.optionCancelDesc'),
  },
]

const MANUAL_NOTICE: readonly string[] = [
  t('tui.dialogs.goalStartPermissionPrompt.notice1'),
  t('tui.dialogs.goalStartPermissionPrompt.notice2'),
  t('tui.dialogs.goalStartPermissionPrompt.notice3'),
]

const YOLO_NOTICE: readonly string[] = [
  t('tui.dialogs.goalStartPermissionPrompt.yoloNotice1'),
  t('tui.dialogs.goalStartPermissionPrompt.yoloNotice2'),
  t('tui.dialogs.goalStartPermissionPrompt.yoloNotice3'),
]

export const GoalStartPermissionPrompt = (props: GoalStartPermissionPromptProps): unknown => {
  const title = props.mode === 'yolo'
    ? t('tui.dialogs.goalStartPermissionPrompt.titleYolo')
    : t('tui.dialogs.goalStartPermissionPrompt.titleManual')
  const notice = props.mode === 'yolo' ? YOLO_NOTICE : MANUAL_NOTICE
  const options = props.mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS
  return (
    <StartPermissionPrompt
      title={title}
      noticeLines={notice}
      options={options}
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  )
}

export const goalStartOptions = (
  mode: 'manual' | 'yolo',
): readonly StartPermissionOption[] => (mode === 'yolo' ? YOLO_OPTIONS : MANUAL_OPTIONS)