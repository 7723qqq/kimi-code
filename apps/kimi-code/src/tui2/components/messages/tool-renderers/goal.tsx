/** @jsxImportSource @opentui/solid */
/**
 * TUI2 goal-tool result renderer.
 *
 * Mirrors `tui/components/messages/tool-renderers/goal.ts`. `goalSummary`
 * renders a compact goal snapshot for CreateGoal/GetGoal results;
 * `buildGoalToolHeader` / `goalStatusChip` feed the tool-call header.
 *
 * `buildGoalToolHeader` keeps the v1 signature (`string | undefined`)
 * but returns *plain* text — the tui2 tool-call header view applies the
 * colour tokens itself instead of embedding ANSI escapes.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { t } from '#/i18n'
import { formatTokenCount } from '#/utils/usage/usage-format'

import { STATUS_BULLET } from '../../../constant/symbols'
import { currentTheme } from '../../../theme'
import type { ToolCallBlockData, ToolResultBlockData } from '../../../types'

import { Box } from '../../common/box'
import { Text as TuiText } from '../../common/text'
import { formatGoalElapsed, pluralizeGoalCount } from '../goal-format'
import { renderTruncated } from './truncated'
import type { ResultRenderer } from './types'

type GoalToolName = 'CreateGoal' | 'GetGoal' | 'SetGoalBudget' | 'UpdateGoal'

interface GoalSnapshotView {
  readonly objective: string
  readonly status: string
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly wallClockMs: number
  readonly terminalReason?: string | undefined
}

const GOAL_TOOLS = new Set<string>(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'])

export function isGoalToolName(toolName: string): toolName is GoalToolName {
  return GOAL_TOOLS.has(toolName)
}

export const goalSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);

  switch (toolCall.name) {
    case 'CreateGoal':
    case 'GetGoal':
      return renderGoalSnapshot(toolCall, result, ctx)
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return <></>
    default:
      return renderTruncated(toolCall, result, ctx)
  }
}

/**
 * Structured goal-tool header parts; the tool-call card paints each part
 * with its colour token (marker + label `primary` — or `error` on
 * failure, argument and chip dim).
 */
export interface GoalToolHeaderParts {
  readonly marker: string
  readonly label: string
  readonly arg: string | undefined
  readonly chip: string
}

export function buildGoalToolHeaderParts(options: {
  readonly toolCall: ToolCallBlockData
  readonly result: ToolResultBlockData | undefined
  readonly bullet: string
  readonly chip: string
}): GoalToolHeaderParts | undefined {
  const { toolCall, result, bullet, chip } = options;
  if (!isGoalToolName(toolCall.name)) return undefined;

  const marker = result !== undefined && result.is_error !== true ? STATUS_BULLET.trimEnd() : bullet;
  const arg =
    toolCall.name === 'UpdateGoal'
      ? undefined
      : formatGoalToolArgument(toolCall.name, toolCall.args);
  return {
    marker,
    label: goalToolLabel(toolCall.name, result, toolCall.args),
    arg,
    chip,
  };
}

/**
 * Plain header text for a goal tool call: `● <label> (<arg>)`, with the
 * v1 colour structure documented for the caller — marker + label paint
 * `primary` (or `error` on failure), the argument dim. Returns undefined
 * for non-goal tools.
 */
export function buildGoalToolHeader(options: {
  readonly toolCall: ToolCallBlockData
  readonly result: ToolResultBlockData | undefined
  readonly bullet: string
  readonly chip: string
}): string | undefined {
  const parts = buildGoalToolHeaderParts(options);
  if (parts === undefined) return undefined;
  const argText = parts.arg === undefined ? '' : ` (${parts.arg})`;
  return `${parts.marker}${parts.label}${argText}${parts.chip}`;
}

function formatGoalBudgetArg(args: Record<string, unknown>): string | undefined {
  const value = args['value'];
  const unit = args['unit'];
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof unit !== 'string') {
    return undefined;
  }
  if (unit.length === 0) return undefined;
  const normalized = unit === 'turns' || unit === 'tokens' ? Math.max(1, Math.round(value)) : value;
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(normalized)} ${normalized === 1 ? singular : unit}`;
}

export function goalStatusChip(output: string): string {
  const goal = parseGoalValue(output);
  if (goal === undefined) return '';
  if (goal === null) return 'no goal';
  return stringField(goal, 'status') ?? '';
}

function renderGoalSnapshot(
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  _ctx: Parameters<ResultRenderer>[2],
) {
  const goal = parseGoalToolOutput(result.output);
  if (goal === undefined) return renderTruncated(toolCall, result, _ctx);

  if (goal === null) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <TuiText fg={currentTheme.color('textDim')} wrapMode="word">
          {t('tui.messages.goalToolNoGoal')}
        </TuiText>
      </Box>
    );
  }

  const rows = [
    {
      text: t('tui.messages.goalToolStatus', {
        status: goal.status,
        objective: truncateOneLine(goal.objective, 96),
      }),
      fg: currentTheme.color('text'),
    },
    {
      text: formatGoalStats(goal),
      fg: currentTheme.color('textDim'),
    },
  ];
  if (goal.terminalReason !== undefined && goal.terminalReason.length > 0) {
    rows.push({ text: goal.terminalReason, fg: currentTheme.color('textDim') });
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((row, i) => (
        <TuiText fg={row.fg} wrapMode="word">
          {i === 0 ? row.text : `  ${row.text}`}
        </TuiText>
      ))}
    </Box>
  );
}

function goalToolLabel(
  toolName: GoalToolName,
  result: ToolResultBlockData | undefined,
  args: Record<string, unknown>,
): string {
  const failed = result?.is_error === true;
  const finished = result !== undefined;
  switch (toolName) {
    case 'CreateGoal':
      return failed
        ? t('tui.messages.goalToolCouldNotStart')
        : finished
          ? t('tui.messages.goalToolStarted')
          : t('tui.messages.goalToolStarting')
    case 'GetGoal':
      return failed
        ? t('tui.messages.goalToolCouldNotCheck')
        : finished
          ? t('tui.messages.goalToolChecked')
          : t('tui.messages.goalToolChecking')
    case 'SetGoalBudget':
      return failed
        ? t('tui.messages.goalToolCouldNotSetBudget')
        : finished
          ? t('tui.messages.goalToolSetBudget')
          : t('tui.messages.goalToolSettingBudget')
    case 'UpdateGoal': {
      const status = stringArg(args, 'status');
      const suffix = status ?? 'status';
      return failed
        ? t('tui.messages.goalToolCouldNotReport', { suffix })
        : finished
          ? t('tui.messages.goalToolReported', { suffix })
          : t('tui.messages.goalToolReporting', { suffix })
    }
  }
}

function formatGoalToolArgument(
  toolName: GoalToolName,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolName) {
    case 'CreateGoal': {
      const objective = stringArg(args, 'objective');
      return objective === undefined ? undefined : truncateOneLine(objective, 60);
    }
    case 'SetGoalBudget':
      return formatGoalBudgetArg(args);
    case 'UpdateGoal':
      return stringArg(args, 'status');
    case 'GetGoal':
      return undefined;
  }
}

function parseGoalToolOutput(output: string): GoalSnapshotView | null | undefined {
  const goal = parseGoalValue(output);
  if (goal === undefined || goal === null) return goal;
  const objective = stringField(goal, 'objective');
  const status = stringField(goal, 'status');
  if (objective === undefined || status === undefined) return undefined;
  return {
    objective,
    status,
    turnsUsed: numberField(goal, 'turnsUsed'),
    tokensUsed: numberField(goal, 'tokensUsed'),
    wallClockMs: numberField(goal, 'wallClockMs'),
    terminalReason: stringField(goal, 'terminalReason'),
  };
}

function parseGoalValue(output: string): Record<string, unknown> | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !('goal' in parsed)) return undefined;
  const goal = parsed['goal'];
  if (goal === null) return null;
  if (!isRecord(goal)) return undefined;
  return goal;
}

function formatGoalStats(goal: GoalSnapshotView): string {
  return [
    pluralizeGoalCount(goal.turnsUsed, 'turn'),
    `${formatTokenCount(goal.tokensUsed)} tokens`,
    formatGoalElapsed(goal.wallClockMs),
  ].join(' · ');
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.replaceAll(/\s+/g, ' ').trim();
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
