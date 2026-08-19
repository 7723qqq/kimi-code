/** @jsxImportSource @opentui/solid */
/**
 * TUI2 `/goal` status box content.
 *
 * Replaces `tui/components/messages/goal-panel.ts` (pi-tui Components
 * that hand-wrapped coloured lines inside a `UsagePanelComponent`) with
 * opentui SolidJS views. The goal-specific layout is unchanged:
 *
 *   ▌ <objective> (blockquote left-trail, wrapped)
 *   ▌ ✓ <completion criterion>
 *
 *   Status     complete — <reason>        (terminal goals only)
 *   Running    4m 12s
 *   Turns      7
 *   Tokens     128.4k
 *   Stop       after 20 turns (7/20)      (or a dim "no stop condition" note)
 *
 * `buildGoalReportLines` / `goalPanelTitle` keep their v1 names but
 * return plain text (the tui2 transcript stores plain content);
 * `GoalStatusMessageView` renders the same layout with palette tokens
 * inside a real opentui bordered box.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { bold, fg, StyledText } from '@opentui/core'
import type { TextChunk } from '@opentui/core'

import type { GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'
import { STATUS_BULLET } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import type { ColorToken } from '../../theme'
import { formatTokenCount } from '#/utils/usage/usage-format'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { formatGoalElapsed } from './goal-format'
import { UsagePanelView } from './usage-panel'

const WRAP_WIDTH = 72
const MAX_OBJECTIVE_LINES = 6
const MAX_CRITERION_LINES = 3
const LABEL_WIDTH = 11

// ── Single-line lifecycle markers ──

function LifecycleLine(props: { label: string }): JSX.Element {
  return (
    <Box flexDirection="row" paddingLeft={2}>
      <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')}>
        {STATUS_BULLET}
      </Text>
      <Text fg={currentTheme.color('primary')} attributes={currentTheme.attributes('bold')} wrapMode="word">
        {props.label}
      </Text>
    </Box>
  )
}

/**
 * The "Goal set" confirmation shown after `/goal <objective>`. The
 * objective is rendered as the following user prompt, so this message
 * only marks the state change in the transcript.
 */
export const GoalSetMessageView: Component = () => (
  <LifecycleLine label={t('tui.messages.goalPanel.goalSet')} />
)

export const UpcomingGoalAddedMessageView: Component = () => (
  <LifecycleLine label={t('tui.messages.goalPanel.upcomingAdded')} />
)

export interface GoalCompletionMessageViewProps {
  readonly message: string
}

export const GoalCompletionMessageView: Component<GoalCompletionMessageViewProps> = (props) => {
  const [headline = '', ...details] = props.message.trim().split(/\r?\n/)
  const detailText = details.join('\n').trim()
  if (headline.length === 0) return <></>

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row">
        <Text fg={currentTheme.color('success')} attributes={currentTheme.attributes('bold')}>
          {STATUS_BULLET}
        </Text>
        <Text fg={currentTheme.color('success')} attributes={currentTheme.attributes('bold')} wrapMode="word">
          {headline}
        </Text>
      </Box>
      {detailText.length > 0 ? (
        <Text fg={currentTheme.color('textDim')} wrapMode="word">
          {detailText}
        </Text>
      ) : null}
    </Box>
  )
}

export interface GoalStatusMessageViewProps {
  readonly goal: GoalSnapshot
}

export const GoalStatusMessageView: Component<GoalStatusMessageViewProps> = (props) => {
  return (
    <UsagePanelView title={goalPanelTitle(props.goal)} borderToken="primary">
      <GoalReportRows goal={props.goal} />
    </UsagePanelView>
  )
}

// ── Report builders ──

/** Box title, e.g. ` Goal · active `. */
export function goalPanelTitle(goal: GoalSnapshot): string {
  return t('tui.messages.goalPanel.title', { status: statusLabel(goal.status) })
}

export function buildGoalReportLines(goal: GoalSnapshot, wrapWidth: number = WRAP_WIDTH): string[] {
  // `complete` is the terminal outcome (the completion card); everything else
  // (active / paused / blocked) is a persisted, resumable goal that still shows
  // its stop condition. A reason is worth surfacing for stopped / complete states.
  const isComplete = goal.status === 'complete'
  const reason = goal.terminalReason
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete
  const lines: string[] = []

  // Condition as a blockquote left-trail. Reserve the visible "▌ " prefix before
  // wrapping so the panel doesn't clip rows that exactly fit the panel interior.
  const blockquoteWrapWidth = Math.max(1, wrapWidth - 2)
  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    lines.push(`▌ ${line}`)
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(
      `✓ ${goal.completionCriterion}`,
      blockquoteWrapWidth,
      MAX_CRITERION_LINES,
    )) {
      lines.push(`▌ ${line}`)
    }
  }
  lines.push('')

  const row = (label: string, val: string): string => `${label.padEnd(LABEL_WIDTH)}${val}`

  if (showReason) {
    lines.push(
      row(
        t('tui.messages.goalPanel.statusLabel'),
        `${statusLabel(goal.status)}${reason !== undefined ? ` — ${reason}` : ''}`,
      ),
    )
  }
  lines.push(row(t('tui.messages.goalPanel.runningLabel'), formatGoalElapsed(goal.wallClockMs)))
  lines.push(row(t('tui.messages.goalPanel.turnsLabel'), `${goal.turnsUsed}`))
  lines.push(row(t('tui.messages.goalPanel.tokensLabel'), formatTokenCount(goal.tokensUsed)))
  if (!isComplete) {
    const stop = formatStopRow(goal)
    lines.push(
      stop !== null
        ? row(t('tui.messages.goalPanel.stopLabel'), stop)
        : t('tui.messages.goalPanel.noStopCondition'),
    )
  }
  return lines
}

/** The configured hard stop(s), or null when the goal is unbounded. */
function formatStopRow(goal: GoalSnapshot): string | null {
  const { budget } = goal
  const parts: string[] = []
  if (budget.turnBudget !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTurns', {
        turnBudget: budget.turnBudget,
        turnsUsed: goal.turnsUsed,
      }),
    )
  }
  if (budget.tokenBudget !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTokens', {
        tokenBudget: formatTokenCount(budget.tokenBudget),
      }),
    )
  }
  if (budget.wallClockBudgetMs !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTime', {
        duration: formatGoalElapsed(budget.wallClockBudgetMs),
      }),
    )
  }
  return parts.length > 0 ? parts.join(', ') : null
}

function statusToken(status: GoalStatus): ColorToken {
  switch (status) {
    case 'active':
      return 'primary'
    case 'complete':
      return 'success'
    case 'blocked':
    case 'budget_limited':
    case 'usage_limited':
      return 'warning'
    case 'paused':
      return 'textDim'
  }
}

function statusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return t('tui.messages.goalPanel.statusActive')
    case 'complete':
      return t('tui.messages.goalPanel.statusComplete')
    case 'blocked':
      return t('tui.messages.goalPanel.statusBlocked')
    case 'paused':
      return t('tui.messages.goalPanel.statusPaused')
    case 'budget_limited':
      return t('tui.messages.goalPanel.statusBudgetLimited')
    case 'usage_limited':
      return t('tui.messages.goalPanel.statusUsageLimited')
  }
}

/** Word-wrap to `width`, capped at `maxLines` (last line gets an ellipsis when clipped). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length > safeWidth && current.length > 0) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  if (lines.length === 0) lines.push('')
  if (lines.length <= maxLines) return lines
  const clipped = lines.slice(0, maxLines)
  const lastLine = clipped[maxLines - 1] ?? ''
  clipped[maxLines - 1] = `${lastLine.slice(0, Math.max(0, safeWidth - 1))}…`
  return clipped
}

// ── Coloured report rows (for the status message view) ──

function GoalReportRows(props: { readonly goal: GoalSnapshot }): JSX.Element {
  const goal = props.goal
  const statusColor = statusToken(goal.status)
  const isComplete = goal.status === 'complete'
  const reason = goal.terminalReason
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete

  const rows: JSX.Element[] = []
  const blockquoteWrapWidth = Math.max(1, WRAP_WIDTH - 2)

  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    rows.push(
      <text wrapMode="word" content={lineToStyled([run('▌ ', statusColor), run(line, 'text')])} />,
    )
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(
      `✓ ${goal.completionCriterion}`,
      blockquoteWrapWidth,
      MAX_CRITERION_LINES,
    )) {
      rows.push(
        <text wrapMode="word" content={lineToStyled([run('▌ ', statusColor), run(line, 'textDim')])} />,
      )
    }
  }
  rows.push(<Text>{' '}</Text>)

  if (showReason) {
    rows.push(
      <text
        wrapMode="word"
        content={lineToStyled([
          run(t('tui.messages.goalPanel.statusLabel').padEnd(LABEL_WIDTH), 'textDim'),
          run(statusLabel(goal.status), statusColor),
          reason !== undefined ? run(` — ${reason}`, 'textDim') : run('', 'text'),
        ])}
      />,
    )
  }
  const fieldRow = (label: string, value: string): JSX.Element => (
    <text
      wrapMode="word"
      content={lineToStyled([run(label.padEnd(LABEL_WIDTH), 'textDim'), run(value, 'text')])}
    />
  )
  rows.push(fieldRow(t('tui.messages.goalPanel.runningLabel'), formatGoalElapsed(goal.wallClockMs)))
  rows.push(fieldRow(t('tui.messages.goalPanel.turnsLabel'), `${goal.turnsUsed}`))
  rows.push(fieldRow(t('tui.messages.goalPanel.tokensLabel'), formatTokenCount(goal.tokensUsed)))
  if (!isComplete) {
    const stop = formatStopRow(goal)
    rows.push(
      stop !== null
        ? fieldRow(t('tui.messages.goalPanel.stopLabel'), stop)
        : <Text fg={currentTheme.color('textDim')}>{t('tui.messages.goalPanel.noStopCondition')}</Text>,
    )
  }

  return <>{rows}</>
}

function run(text: string, token: ColorToken, style?: 'bold'): TextChunk {
  const chunk = fg(currentTheme.hex(token))(text)
  return style === 'bold' ? bold(chunk) : chunk
}

function lineToStyled(parts: readonly TextChunk[]): StyledText {
  return new StyledText([...parts])
}
