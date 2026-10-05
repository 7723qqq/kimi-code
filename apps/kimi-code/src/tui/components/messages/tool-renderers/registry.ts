/**
 * Tool result renderer registry.
 *
 * Each tool name maps to a `ResultRenderer` that turns the tool's
 * `ToolResultBlockData` into renderable Components. Tools without an
 * explicit entry fall through to `renderTruncated` (short output shown whole
 * when collapsed, otherwise its first line; full output on ctrl+o; errors
 * always previewed).
 *
 * Keep this dispatch flat — tool names live next to the renderer they
 * choose, so adding a new tool means appending one case.
 */

import { shellExecutionResultRenderer } from '../shell-execution';
import { goalSummary } from './goal';
import { parseReadMediaOutput, readMediaSummary } from './media';
import { waitForSummary } from './wait-for';
import {
  fetchSummary,
  fileChangeSummary,
  globSummary,
  grepSummary,
  readSummary,
  thinkSummary,
  webSearchSummary,
} from './summary';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

/**
 * True when a tool has no dedicated renderer and falls back to the generic
 * truncated output (every MCP tool and any tool not listed below). Used to
 * decide whether subagent sub-tool output should be previewed the same way
 * the main agent previews it.
 */
export function isGenericToolResult(toolName: string): boolean {
  return pickResultRenderer(toolName) === renderTruncated;
}

const readResultRenderer: ResultRenderer = (toolCall, result, ctx) =>
  result.is_error !== true && parseReadMediaOutput(result.output) !== null
    ? readMediaSummary(toolCall, result, ctx)
    : readSummary(toolCall, result, ctx);

export function pickResultRenderer(toolName: string): ResultRenderer {
  switch (toolName) {
    case 'Read':
      return readResultRenderer;
    case 'ReadMediaFile':
      return readMediaSummary;
    case 'Grep':
      return grepSummary;
    case 'Glob':
      return globSummary;
    case 'FetchURL':
      return fetchSummary;
    case 'WebSearch':
      return webSearchSummary;
    case 'Bash':
      return shellExecutionResultRenderer;
    case 'Think':
      return thinkSummary;
    case 'Edit':
      return fileChangeSummary;
    case 'Write':
      return fileChangeSummary;
    case 'CreateGoal':
    case 'GetGoal':
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return goalSummary;
    case 'WaitFor':
      return waitForSummary;
    default:
      return renderTruncated;
  }
}

export type { ResultRenderer } from './types';
