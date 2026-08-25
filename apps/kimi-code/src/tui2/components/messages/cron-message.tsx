/** @jsxImportSource @opentui/solid */
/**
 * TUI2 cron job message card.
 *
 * Replaces `tui/components/messages/cron-message.ts`'s
 * `CronMessageComponent` (a pi-tui `Component`) with an opentui SolidJS
 * view. A fired (or missed) scheduled job renders as:
 *
 *   ● Cron job fired
 *     <cron spec> | job 123 · one-shot | 2 missed
 *     <prompt text>
 *
 * The title bullet is bold and colored: `accent` for a clean fire,
 * `warning` for a stale / missed delivery. The detail line (cron spec,
 * job id, one-shot flag, coalesced/missed counts, final-delivery notice)
 * and the echoed prompt render dim / plain below. `cronDetail` stays a
 * pure function (verbatim from v1) so it can be unit-tested.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { CronTranscriptData } from '../../types'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface CronMessageViewProps {
  readonly prompt: string
  readonly data: CronTranscriptData
}

/** Detail line parts (cron spec · job · one-shot · coalesced · missed · final), verbatim from v1. */
export function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) {
    parts.push(t('tui.messages.cronMessage.job', { jobId: data.jobId }));
  }
  if (data.recurring === false) parts.push(t('tui.messages.cronMessage.oneShot'));
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(t('tui.messages.cronMessage.coalesced', { count: data.coalescedCount }));
  }
  if (data.missedCount !== undefined) {
    parts.push(t('tui.messages.cronMessage.missed', { count: data.missedCount }));
  }
  if (data.stale === true) parts.push(t('tui.messages.cronMessage.finalDelivery'));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

export const CronMessageView: Component<CronMessageViewProps> = (props) => {
  const missed = (): boolean => props.data.missedCount !== undefined
  const title = (): string =>
    missed()
      ? t('tui.messages.cronMessage.missedTitle')
      : t('tui.messages.cronMessage.firedTitle')
  const titleToken = (): 'warning' | 'accent' =>
    props.data.stale === true || missed() ? 'warning' : 'accent'
  const titleFg = (): ColorInput => currentTheme.color(titleToken())
  const detail = (): string | undefined => cronDetail(props.data)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={currentTheme.attributes('bold')}>
          {STATUS_BULLET}
        </Text>
        <Text fg={titleFg()} attributes={currentTheme.attributes('bold')} wrapMode="word">
          {title()}
        </Text>
      </Box>
      <Show when={detail() !== undefined}>
        <Text fg={currentTheme.color('textDim')} wrapMode="word">
          {detail()}
        </Text>
      </Show>
      <Text fg={currentTheme.color('text')} wrapMode="word">
        {props.prompt}
      </Text>
    </Box>
  )
}
