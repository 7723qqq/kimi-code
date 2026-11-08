import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { WireLineRange } from '#/wire/record';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { IAgentTodoService } from '#/features/todo/todoService';
import type { IAgentTaskService } from '#/agent/task/task';
import type { IAssociativeMemoryService } from '#/features/associativeMemory/service';
import type { IWireService } from '#/wire/wire';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { TokenUsage } from '#human/llm/usage';

import { historySafeToCompact } from './compactionUtils';
import { buildCompactionSummaryText } from '#/agent/contextMemory/compactionHandoff';
import { renderTodoList } from '#/features/todo/todoItem';
import { renderContextRecoveryPointer } from './contextRecovery';
import { fullCompactionWireRangesKey } from './compactionOps';

export interface CompactionApplyDeps {
  readonly context: IAgentContextMemoryService;
  readonly todo: IAgentTodoService;
  readonly task: IAgentTaskService;
  readonly associativeMemory: IAssociativeMemoryService;
  readonly wire: IWireService;
  readonly states: IAgentStateService;
  readonly estimateText: (text: string) => number;
}

export interface CompactionApplyInput {
  readonly attemptSummary: string;
  readonly attemptUsage: TokenUsage | null;
  readonly originalHistory: readonly ContextMessage[];
  readonly nonHistoryStateBefore: string;
  readonly tokensBefore: number;
  readonly droppedCount: number;
  readonly requestOverheadTokens: number;
  readonly inFlightTurn: readonly ContextMessage[];
}

export interface CompactionApplyResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly droppedCount: number | undefined;
}

export async function applyCompactionRound(
  deps: CompactionApplyDeps,
  input: CompactionApplyInput,
  signal: AbortSignal,
  cancel: () => never,
): Promise<CompactionApplyResult> {
  if (!historySafeToCompact(deps.context.get(), input.originalHistory)) cancel();
  if (nonHistoryStateFingerprint(deps) !== input.nonHistoryStateBefore) cancel();
  const summary = await postProcessSummary(deps, input.attemptSummary);
  const wireLines = await captureWireLines(deps);
  signal.throwIfAborted();
  const recoveryFooter = renderRecoveryFooter(deps, wireLines);
  const summaryText = buildCompactionSummaryText(summary);
  const result = deps.context.applyCompaction({
    summary,
    contextSummary: recoveryFooter === undefined ? summaryText : `${summaryText}\n\n${recoveryFooter}`,
    compactedCount: input.originalHistory.length,
    tokensBefore: input.tokensBefore,
    inFlightTurn: input.inFlightTurn,
    summaryOutputTokens:
      input.attemptUsage === null
        ? undefined
        : input.attemptUsage.output + (recoveryFooter === undefined ? 0 : deps.estimateText(recoveryFooter)),
    requestOverheadTokens: input.requestOverheadTokens,
    droppedCount: input.droppedCount === 0 ? undefined : input.droppedCount,
    wireLines,
  });
  try {
    await deps.associativeMemory.writeNote(summary, 'project', 'external');
  } catch (error) {
    onUnexpectedError(error);
  }
  return {
    summary,
    compactedCount: result.compactedCount,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    droppedCount: result.droppedCount,
  };
}

export function nonHistoryStateFingerprint(deps: CompactionApplyDeps): string {
  return JSON.stringify({
    todos: deps.todo.get(),
    tasks: deps.task.list(true),
  });
}

async function postProcessSummary(deps: CompactionApplyDeps, summary: string): Promise<string> {
  const todos = deps.todo.get();
  if (todos.length === 0) return summary;
  return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
}

async function captureWireLines(deps: CompactionApplyDeps): Promise<WireLineRange | undefined> {
  try {
    await deps.wire.flush();
  } catch (error) {
    onUnexpectedError(error);
    return undefined;
  }
  const end = deps.wire.lineCount();
  const previous = deps.states.get(fullCompactionWireRangesKey).at(-1);
  const start = Math.max(previous?.end ?? 0, deps.wire.lastContextClearLine() ?? 0) + 1;
  if (end < start) return undefined;
  return { start, end };
}

function renderRecoveryFooter(
  deps: CompactionApplyDeps,
  wireLines: WireLineRange | undefined,
): string | undefined {
  if (wireLines === undefined) return undefined;
  const journalPath = deps.wire.journalPath();
  if (journalPath === undefined) return undefined;
  const windows = [...deps.states.get(fullCompactionWireRangesKey), wireLines];
  return renderContextRecoveryPointer({ journalPath, windows });
}
