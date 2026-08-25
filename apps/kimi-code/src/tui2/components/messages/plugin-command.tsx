/** @jsxImportSource @opentui/solid */
/**
 * TUI2 plugin command invocation card.
 *
 * Replaces `tui/components/messages/plugin-command.ts`'s
 * `PluginCommandComponent` (a pi-tui `Container`) with an opentui SolidJS
 * view. When the user runs `/plugin:command args`, the transcript shows a
 * compact card instead of expanding the command body into the user bubble:
 *
 *   ▶ /plugin:command
 *     args
 *
 * The args line is optional and capped at {@link ARGS_PREVIEW_MAX} chars.
 * The `▶` prefix and the label use the primary / roleUser hues (bold),
 * mirroring v1's `boldFg('primary', …)` + `boldFg('roleUser', …)`.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'

import { t } from '#/i18n'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ARGS_PREVIEW_MAX = 200

export interface PluginCommandViewProps {
  readonly pluginId: string
  readonly commandName: string
  readonly args?: string
}

/** Trim args and cap the preview at ARGS_PREVIEW_MAX chars (undefined when blank). */
export function previewPluginCommandArgs(args: string | undefined): string | undefined {
  const trimmed = args?.trim() ?? ''
  if (trimmed.length === 0) return undefined
  return trimmed.length > ARGS_PREVIEW_MAX ? `${trimmed.slice(0, ARGS_PREVIEW_MAX)}…` : trimmed
}

export const PluginCommandView: Component<PluginCommandViewProps> = (props) => {
  const label = (): string => `/${props.pluginId}:${props.commandName}`
  const preview = (): string | undefined => previewPluginCommandArgs(props.args)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
          {t('tui.messages.pluginCommand.invoked')}
        </Text>
        <Text fg={currentTheme.color('roleUser')} attributes={currentTheme.attributes('bold')}>
          {label()}
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
