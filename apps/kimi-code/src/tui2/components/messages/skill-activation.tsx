/** @jsxImportSource @opentui/solid */
/**
 * TUI2 skill activation card.
 *
 * Replaces `tui/components/messages/skill-activation.ts`'s
 * `SkillActivationComponent` (a pi-tui `Container`) with an opentui
 * SolidJS view. When the user runs `/skill:foo bar`, the transcript shows
 * a compact card instead of expanding the SKILL.md body into the user
 * bubble:
 *
 *   ▶ Activated skill: foo
 *     bar
 *
 * The args line is optional and capped at {@link ARGS_PREVIEW_MAX} chars.
 * Colors mirror v1: bold `primary` prefix + bold `roleUser` name.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'

import { t } from '#/i18n'
import { currentTheme } from '../../theme'
import type { SkillActivationTrigger } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type { SkillActivationTrigger }

const ARGS_PREVIEW_MAX = 200

export interface SkillActivationViewProps {
  readonly name: string
  readonly args?: string
  readonly trigger?: SkillActivationTrigger
}

/** Trim args and cap the preview at ARGS_PREVIEW_MAX chars (undefined when blank). */
export function previewSkillActivationArgs(args: string | undefined): string | undefined {
  const trimmed = args?.trim() ?? ''
  if (trimmed.length === 0) return undefined
  return trimmed.length > ARGS_PREVIEW_MAX ? `${trimmed.slice(0, ARGS_PREVIEW_MAX)}…` : trimmed
}

export const SkillActivationView: Component<SkillActivationViewProps> = (props) => {
  const preview = (): string | undefined => previewSkillActivationArgs(props.args)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
          {t('tui.messages.skillActivation.activated')}
        </Text>
        <Text fg={currentTheme.color('roleUser')} attributes={currentTheme.attributes('bold')}>
          {props.name}
        </Text>
      </Box>
      <Show when={preview() !== undefined}>
        <Text fg={currentTheme.color('textDim')} wrapMode="word">
          {`  ${preview()}`}
        </Text>
      </Show>
    </Box>
  )
}
