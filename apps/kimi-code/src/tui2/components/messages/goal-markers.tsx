/** @jsxImportSource @opentui/solid */
/**
 * TUI2 low-profile transcript markers for the autonomous goal loop.
 *
 * Replaces `tui/components/messages/goal-markers.ts`'s
 * `GoalMarkerComponent` (a pi-tui `Component` with imperative
 * setExpanded/setNavigated/handleClick) with a pure spec builder +
 * opentui SolidJS view:
 *
 *   ◦ Goal paused (ctrl+o)      ← collapsed, expandable
 *   ◦ Goal paused               ← expanded: reason lines follow
 *     <reason>
 *
 * Lifecycle changes (paused / resumed / cancelled) and `no_progress`
 * verdicts render as a single dim line that expands (ctrl+o, shared with
 * tool output) to show the reason when there is one. Terminal outcomes
 * use the richer completion card (the `/goal` box), not this marker.
 *
 * `buildGoalMarker` keeps its v1 name and signature but returns a
 * `GoalMarkerSpec` (pure data) instead of a component instance; the
 * view applies expansion/navigation state from its own props.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import type { GoalChange } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorToken } from '../../theme'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

const HEAD_INDENT = '  '

export type GoalMarkerActor = 'user' | 'model' | 'runtime' | 'system'

/** Pure description of a goal marker; `GoalMarkerView` renders it. */
export interface GoalMarkerSpec {
  readonly headline: string
  readonly detail: string | undefined
  readonly accentToken: ColorToken
  readonly marker: string
  readonly textToken: ColorToken
  readonly expandable: boolean
  readonly indent: string
  readonly leadingBlank: boolean
}

export interface GoalMarkerViewProps {
  readonly spec: GoalMarkerSpec
  /** Navigation-mode focus: accent background on the header row. */
  readonly navigated?: boolean
  /** Expansion state (ctrl+o); detail renders when true. */
  readonly expanded?: boolean
  /** Fired on click (host toggles expansion). */
  readonly onToggle?: () => void
}

export const GoalMarkerView: Component<GoalMarkerViewProps> = (props) => {
  const hasDetail = (): boolean =>
    props.spec.detail !== undefined && props.spec.detail.length > 0
  const headerBackground = (): ColorInput | undefined =>
    props.navigated === true ? currentTheme.color('accent') : undefined
  const showDetail = (): boolean =>
    props.spec.expandable && hasDetail() && props.expanded === true

  return (
    <Clickable
      onClick={() => {
        if (props.spec.expandable) props.onToggle?.()
      }}
    >
      <Box flexDirection="column" backgroundColor={headerBackground()}>
        <Show when={props.spec.leadingBlank}>
          <Text>{' '}</Text>
        </Show>
        <Box flexDirection="row" paddingLeft={2}>
          <Text fg={currentTheme.color(props.spec.accentToken)}>{props.spec.marker}</Text>
          <Text fg={currentTheme.color(props.spec.textToken)} wrapMode="word">
            {props.spec.headline}
          </Text>
          <Show when={props.spec.expandable && hasDetail() && props.expanded !== true}>
            <Text fg={currentTheme.color('textMuted')} wrapMode="word">
              {' (ctrl+o)'}
            </Text>
          </Show>
        </Box>
        <Show when={showDetail()}>
          <Text fg={currentTheme.color('textDim')} wrapMode="word">
            {`    ${props.spec.detail}`}
          </Text>
        </Show>
      </Box>
    </Clickable>
  )
}

/**
 * Builds a marker spec for a lifecycle change (paused / resumed /
 * blocked), or `null` when the change should be silent (a `completion`
 * change posts its own message, not a marker). `expanded` seeds the
 * initial ctrl+o state.
 */
export function buildGoalMarker(
  change: GoalChange,
  expanded: boolean,
  actor?: GoalMarkerActor,
): GoalMarkerSpec | null {
  const spec = markerSpec(change, actor)
  if (spec === null) return null
  return {
    headline: spec.headline,
    detail: spec.detail ?? change.reason,
    accentToken: spec.accentToken,
    marker: spec.options?.marker ?? '◦',
    textToken: spec.options?.textToken ?? 'textDim',
    expandable: spec.options?.expandable ?? true,
    indent: spec.options?.indent ?? HEAD_INDENT,
    leadingBlank: spec.options?.leadingBlank ?? false,
  }
}

function markerSpec(
  change: GoalChange,
  actor?: GoalMarkerActor,
): {
  headline: string
  accentToken: ColorToken
  detail?: string | undefined
  options?: GoalMarkerOptions | undefined
} | null {
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return prominentMarker(pausedHeadline(change.reason, actor), 'warning')
      case 'active':
        return prominentMarker(resumedHeadline(actor), 'primary')
      case 'blocked':
        // The system stopped pursuing the goal; resumable via `/goal resume`.
        return { headline: t('tui.messages.goalMarkers.blocked'), accentToken: 'warning' }
      default:
        return null
    }
  }
  return null // completion -> posts its own message, not a marker
}

interface GoalMarkerOptions {
  readonly marker?: string
  readonly textToken?: ColorToken
  readonly expandable?: boolean
  readonly indent?: string
  readonly leadingBlank?: boolean
}

function prominentMarker(headline: string, accentToken: ColorToken) {
  return {
    headline,
    accentToken,
    detail: undefined,
    options: {
      marker: STATUS_BULLET.trimEnd(),
      textToken: accentToken,
      expandable: false,
      indent: '',
      leadingBlank: true,
    },
  }
}

function pausedHeadline(reason: string | undefined, actor: GoalMarkerActor | undefined): string {
  if (reason === 'Paused after interruption')
    return t('tui.messages.goalMarkers.pausedInterruption')
  if (actor === 'user') return t('tui.messages.goalMarkers.pausedByUser')
  if (reason?.startsWith('Paused ') === true) {
    return t('tui.messages.goalMarkers.pausedWithLowerReason', { reason: lowercaseFirst(reason) })
  }
  if (reason !== undefined && reason.length > 0) {
    return t('tui.messages.goalMarkers.pausedWithReason', { reason })
  }
  if (actor === 'model') return t('tui.messages.goalMarkers.pausedByAgent')
  return t('tui.messages.goalMarkers.pausedGeneric')
}

function resumedHeadline(actor: GoalMarkerActor | undefined): string {
  if (actor === 'user') return t('tui.messages.goalMarkers.resumedByUser')
  if (actor === 'model') return t('tui.messages.goalMarkers.resumedByAgent')
  return t('tui.messages.goalMarkers.resumedGeneric')
}

function lowercaseFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`
}
