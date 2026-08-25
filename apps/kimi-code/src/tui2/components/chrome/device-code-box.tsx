/** @jsxImportSource @opentui/solid */
/**
 * TUI2 OAuth device-code panel rendered inside the transcript.
 *
 * Replaces `tui/components/chrome/device-code-box.ts`'s
 * `DeviceCodeBoxComponent` (a pi-tui `Component` whose `render(width)`
 * returned ANSI strings) with an opentui SolidJS view. The rounded-border
 * layout mirrors the v1 welcome panel so the login prompt matches the rest
 * of the chrome; all colors flow through the active palette so theme
 * switches take effect on the next render.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface DeviceCodeBoxParams {
  readonly title: string
  readonly url: string
  readonly code: string
  readonly hint?: string
}

export const DeviceCodeBoxView: Component<DeviceCodeBoxParams> = (props) => {
  const borderColor = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('textStrong')
  const dimFg = (): ColorInput => currentTheme.color('textDim')
  const urlFg = (): ColorInput => currentTheme.color('primary')
  const codeFg = (): ColorInput => currentTheme.color('accent')

  return (
    <Box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderColor()}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Text fg={titleFg()} attributes={currentTheme.attributes('bold')} wrapMode="word">
        {props.title}
      </Text>
      <Text fg={dimFg()} wrapMode="word">
        {t('tui.chrome.deviceCodeBox.prompt')}
      </Text>
      <Text fg={urlFg()} wrapMode="word">
        {props.url}
      </Text>
      <Text attributes={currentTheme.attributes('bold')} wrapMode="word">
        <Text fg={dimFg()}>{t('tui.chrome.deviceCodeBox.codeLabel')}</Text>
        <Text fg={codeFg()}>{props.code}</Text>
      </Text>
      {props.hint !== undefined && props.hint.length > 0 ? (
        <Text fg={dimFg()} wrapMode="word">
          {props.hint}
        </Text>
      ) : null}
    </Box>
  )
}
