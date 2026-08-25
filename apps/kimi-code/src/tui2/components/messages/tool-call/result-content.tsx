/** @jsxImportSource @opentui/solid */
/**
 * TUI2 result content coordinator — builds the result preview body for a
 * completed tool call.
 *
 * Replaces `tui/components/messages/tool-call/result-content.ts`'s
 * `buildResultContent` (which returned pi-tui `Component[]`) with a pure
 * dispatcher returning a SolidJS element. Specialised per-tool summaries
 * (AgentSwarm, Team, AskUserQuestion) live here; generic tools fall
 * through to the `pickResultRenderer` registry.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { JSX } from 'solid-js'
import { fg, StyledText } from '@opentui/core'

import { t } from '#/i18n'
import { FAILURE_MARK, SUCCESS_MARK } from '../../../constant/symbols'
import { currentTheme } from '../../../theme'
import type { ColorToken } from '../../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../../types'

import { Box } from '../../common/box'
import { Text } from '../../common/text'
import { agentSwarmResultSummaryFromOutput } from '../agent-swarm-progress'
import { pickResultRenderer } from '../tool-renderers/registry'
import { interpretExitPlanModeOutcome, isExitPlanModeOutcomeOutput } from './plan-mode'

/** Inputs needed to render a tool call's result body. */
export interface ResultContentContext {
  readonly toolCall: ToolCallBlockData
  readonly result: ToolResultBlockData
  readonly expanded: boolean
  /**
   * True when this tool call is an Agent call whose SubagentStateManager
   * has live state. The coordinator must skip the generic result renderer
   * because the single-subagent block owns its own body.
   */
  readonly isSingleSubagentView: boolean
}

/**
 * Dispatch a completed tool call's result to the right renderer.
 *
 * Order of checks mirrors the original ToolCallComponent.buildContent:
 *   1. AgentSwarm  -> specialised summary header
 *   2. Team -> specialised summary header
 *   3. empty output / system-reminder -> nothing
 *   4. single-subagent view -> nothing (subagent block handles it)
 *   5. ExitPlanMode rejected -> feedback suggestion block
 *   6. TodoList / EnterPlanMode success -> nothing
 *   7. AskUserQuestion (foreground) -> Q/A block
 *   8. otherwise -> registry renderer (Read/Grep/Bash/Edit/Write/...)
 */
export function buildResultContent(ctx: ResultContentContext): JSX.Element {
  const { toolCall, result, expanded, isSingleSubagentView } = ctx

  if (toolCall.name === 'AgentSwarm') return buildAgentSwarmResultSummary(result)
  if (toolCall.name === 'Team') return buildTeamResultSummary(result)
  if (!result.output) return <></>
  if (isSingleSubagentView) return <></>
  if (result.output.trimStart().startsWith('<system-reminder>')) return <></>

  if (toolCall.name === 'ExitPlanMode' && isExitPlanModeOutcomeOutput(result.output)) {
    const outcome = interpretExitPlanModeOutcome(result.output)
    if (outcome.kind === 'rejected' && outcome.feedback !== undefined) {
      const trimmed = outcome.feedback.trim()
      if (trimmed.length > 0) return buildExitPlanModeRejectedFeedback(trimmed)
    }
    return <></>
  }

  if (toolCall.name === 'TodoList' && !result.is_error) return <></>
  if (toolCall.name === 'EnterPlanMode' && !result.is_error) return <></>

  if (
    toolCall.name === 'AskUserQuestion' &&
    toolCall.args['background'] !== true &&
    !result.is_error
  ) {
    const rendered = renderAskUserQuestionResult(result.output)
    if (rendered !== null) return rendered
  }

  const renderer = pickResultRenderer(toolCall.name)
  return renderer(toolCall, result, { expanded })
}

// ── Styled-chunk helpers ──

function run(text: string, token: ColorToken): StyledText {
  return new StyledText([fg(currentTheme.hex(token))(text)])
}

function lineToStyled(parts: StyledText[]): StyledText {
  const chunks = parts.flatMap((styled) => styled.chunks)
  return new StyledText(chunks)
}

// ── ExitPlanMode rejected feedback ──

function buildExitPlanModeRejectedFeedback(feedback: string): JSX.Element {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text fg={currentTheme.color('warning')} attributes={currentTheme.attributes('bold')} wrapMode="word">
        {t('tui.messages.toolCall.suggestionLabel')}
      </Text>
      {feedback.split('\n').map((line) => (
        <Text fg={currentTheme.color('text')} wrapMode="word">
          {`  ${line}`}
        </Text>
      ))}
    </Box>
  )
}

// ── AskUserQuestion ──

function renderAskUserQuestionResult(output: string): JSX.Element | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const answers = (parsed as { answers?: unknown }).answers
  const note = (parsed as { note?: unknown }).note

  const hasAnswers =
    typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0

  if (!hasAnswers) {
    const noteText =
      typeof note === 'string' && note.length > 0
        ? note
        : t('tui.messages.toolCall.userDismissedQuestion')
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text fg={currentTheme.color('textDim')} attributes={currentTheme.attributes('dim')} wrapMode="word">
          {noteText}
        </Text>
      </Box>
    )
  }

  const rows: JSX.Element[] = []
  for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
    const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer)
    rows.push(
      <text
        wrapMode="word"
        content={lineToStyled([run('Q  ', 'textDim'), run(question, 'text')])}
      />,
    )
    rows.push(
      <text
        wrapMode="word"
        content={lineToStyled([run('→  ', 'primary'), run(answerText, 'text')])}
      />,
    )
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows}
    </Box>
  )
}

// ── Team ──

function buildTeamResultSummary(result: ToolResultBlockData): JSX.Element {
  const transcriptMatch = result.output.match(/<transcript>([\s\S]*?)<\/transcript>/)
  const summaryTextMatch = result.output.match(/<final_summary>([\s\S]*?)<\/final_summary>/)

  const speechCount =
    result.is_error === true
      ? 0
      : (
          transcriptMatch?.[1]?.split('\n\n').filter((l) => l.trim().startsWith('[')).length ??
          0
        )

  const segments: StyledText[] = []
  if (speechCount > 0) {
    segments.push(run(`${String(speechCount)} speeches`, 'text'))
  }
  if (result.is_error === true) {
    segments.push(
      run(`${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedPeriod')}`, 'error'),
    )
  } else {
    segments.push(
      run(`${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedPeriod')}`, 'success'),
    )
  }

  const header = lineToStyled([
    run(t('tui.messages.toolCall.teamLabel'), 'textDim'),
    ...segments.flatMap((segment, i) => (i > 0 ? [run(' · ', 'textDim'), segment] : [segment])),
  ])

  const summaryText = summaryTextMatch?.[1]
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <text wrapMode="word" content={header} />
      {summaryText !== null && summaryText !== undefined && summaryText.trim().length > 0 ? (
        <>
          <Text>{' '}</Text>
          <Text fg={currentTheme.color('primary')} wrapMode="word">
            {t('tui.messages.toolCall.teamSummary')}
          </Text>
          {summaryText.trim().split('\n').map((line) => (
            <Text fg={currentTheme.color('text')} wrapMode="word">
              {`  ${line}`}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  )
}

// ── AgentSwarm ──

export const ABORTED_MARK = '⊘'

function buildAgentSwarmResultSummary(result: ToolResultBlockData): JSX.Element {
  const summary = agentSwarmResultSummaryFromOutput(result.output)
  const segments: StyledText[] = []

  if (summary.completed > 0) {
    segments.push(
      run(
        `${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedStatus', { count: summary.completed })}`,
        'success',
      ),
    )
  }
  if (summary.failed > 0) {
    segments.push(
      run(
        `${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedStatus', { count: summary.failed })}`,
        'error',
      ),
    )
  }
  if (summary.aborted > 0) {
    segments.push(
      run(
        `${ABORTED_MARK} ${t('tui.messages.toolCall.abortedStatus', { count: summary.aborted })}`,
        'warning',
      ),
    )
  }

  if (segments.length > 0) {
    const headerText = lineToStyled([
      run(t('tui.messages.toolCall.agentSwarmLabel'), 'textDim'),
      ...segments.flatMap((segment, i) => (i > 0 ? [run(' · ', 'textDim'), segment] : [segment])),
    ])
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <text wrapMode="word" content={headerText} />
      </Box>
    )
  }

  const isAborted = result.is_error === true && /\b(?:aborted|cancelled)\b/i.test(result.output)
  const colorToken = isAborted ? 'warning' : result.is_error === true ? 'error' : 'success'
  const label = isAborted
    ? `${ABORTED_MARK} ${t('tui.messages.toolCall.abortedPeriod')}`
    : result.is_error === true
      ? `${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedPeriod')}`
      : `${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedPeriod')}`
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <text
        wrapMode="word"
        content={lineToStyled([run(t('tui.messages.toolCall.agentSwarmLabel'), 'textDim'), run(label, colorToken)])}
      />
    </Box>
  )
}

// Helper used by callers that need to know whether the output looks like an
// ExitPlanMode outcome without re-parsing.
export function isExitPlanModeRejectedResult(result: ToolResultBlockData): boolean {
  if (!isExitPlanModeOutcomeOutput(result.output)) return false
  return interpretExitPlanModeOutcome(result.output).kind === 'rejected'
}
