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
 * The host (`controllers/kimi-tui.ts` → `showLoginAuthorizationPrompt`)
 * records the pending login as an *active card* (see `setDeviceCodeCard`)
 * keyed by the transcript entry id it appended. MainShell swaps that entry's
 * plain status row for this view while the entry is on screen — the store
 * slice for a full transcript-borne payload would need `state.tsx`, which is
 * outside this feature's boundary, so the holder lives next to the view.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal } from 'solid-js'
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

/** The login card currently rendered over its status entry, if any. */
export interface ActiveDeviceCodeCard extends DeviceCodeBoxParams {
  /** Transcript entry id whose plain status row this card replaces. */
  readonly entryId: string
}

const [cardSignal, setCardSignal] = createSignal<ActiveDeviceCodeCard | undefined>(undefined)

/** Record the device-code card to render for a freshly appended entry. */
export function setDeviceCodeCard(card: ActiveDeviceCodeCard): void {
  setCardSignal(card)
}

/** Drop the active card (login finished / transcript cleared). */
export function clearDeviceCodeCard(): void {
  setCardSignal(undefined)
}

/** Reactive accessor — call inside JSX tracking scopes. */
export function activeDeviceCodeCard(): ActiveDeviceCodeCard | undefined {
  return cardSignal()
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
