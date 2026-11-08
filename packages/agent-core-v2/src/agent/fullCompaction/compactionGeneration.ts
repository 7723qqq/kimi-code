import { retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { createUserMessage, type Message } from '#/llm-adapter/contract/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { runWithCredentialRecovery } from '#/llm-adapter/model/credential-recovery';
import type { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { unwrapErrorCause } from '#/errors';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  collectSummary,
  CompactionTruncatedError,
  dropOldestMessageAndLeadingToolResults,
  shrinkCompactionHistoryAfterOverflow,
  snipLargeToolResults,
  type CompactionAttemptResult,
} from './compactionUtils';

export const COMPLETION_BUDGET_ESTIMATE_MARGIN_RATIO = 0.02;
export const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;

export interface CompactionGenerationState {
  retryCount: number;
}

export interface CompactionGenerationDeps {
  readonly state: CompactionGenerationState;
  readonly history: readonly ContextMessage[];
  readonly instruction: string;
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly compactionMaxOutputSize: number | undefined;
  readonly originTurnId: number | undefined;
  readonly requestTokens: (messages: readonly Message[]) => number;
  readonly estimateMessage: (message: Message) => number;
  readonly getEffectiveMaxContextTokens: () => number;
  readonly llmRequester: IAgentLLMRequesterService;
  readonly preShrinkHistory: (
    history: readonly ContextMessage[],
    instruction: string,
    maxOutputSize: number | undefined,
  ) => readonly ContextMessage[];
  readonly shouldRecoverFromContextOverflow: (error: unknown, estimatedTokens: number) => boolean;
  readonly observeContextOverflow: (estimatedTokens: number) => void;
  readonly setTrace: (trace: LLMRequestTrace) => void;
}

export interface CompactionGenerationOutcome {
  readonly attempt: CompactionAttemptResult;
  readonly droppedCount: number;
}

export async function generateCompactionSummary(
  deps: CompactionGenerationDeps,
): Promise<CompactionGenerationOutcome> {
  const {
    state,
    history,
    instruction,
    signal,
    maxAttempts,
    compactionMaxOutputSize,
    originTurnId,
    requestTokens,
    estimateMessage,
    getEffectiveMaxContextTokens,
    llmRequester,
    preShrinkHistory,
    shouldRecoverFromContextOverflow,
    observeContextOverflow,
    setTrace,
  } = deps;
  let attempt: CompactionAttemptResult | undefined;
  let historyForModel = history;
  let droppedCount = 0;
  let overflowShrinkCount = 0;
  let requestAttempts = 0;
  let cacheProbePending = true;
  const preShrunkHistory = preShrinkHistory(historyForModel, instruction, compactionMaxOutputSize);
  droppedCount += historyForModel.length - preShrunkHistory.length;
  historyForModel = preShrunkHistory;
  while (true) {
    const messagesToCompact = historyForModel;
    const snipped = snipLargeToolResults(messagesToCompact);
    const messages: Message[] = [...snipped, createUserMessage(instruction)];
    const estimatedCompactionRequestTokens = requestTokens(messages);
    const effectiveMaxTokens = getEffectiveMaxContextTokens();
    const usedContextTokens =
      effectiveMaxTokens > 0
        ? estimatedCompactionRequestTokens +
          Math.ceil(effectiveMaxTokens * COMPLETION_BUDGET_ESTIMATE_MARGIN_RATIO)
        : undefined;
    requestAttempts += 1;

    try {
      const runRequest = async () => {
        const request = llmRequester.start(
          {
            messages,
            maxOutputSize: compactionMaxOutputSize,
            usedContextTokens,
            promptCacheProbe: cacheProbePending ? 'compaction' : undefined,
            source: {
              type: 'operation',
              turnId: originTurnId,
              requestKind: 'full_compaction',
              logFields: { droppedCount },
            },
          },
          undefined,
          signal,
        );
        setTrace(request.trace);
        return request.result;
      };
      const result = await runWithCredentialRecovery(
        llmRequester.currentCredentialProvider(),
        runRequest,
        signal,
      );
      cacheProbePending = false;
      attempt = collectSummary(result);
      break;
    } catch (error) {
      const isContextOverflow = shouldRecoverFromContextOverflow(
        error,
        estimatedCompactionRequestTokens,
      );
      if (isContextOverflow) {
        observeContextOverflow(estimatedCompactionRequestTokens);
        overflowShrinkCount += 1;
        if (
          overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
          requestAttempts >= maxAttempts ||
          messagesToCompact.length <= 1
        ) {
          throw error;
        }
        const before = messagesToCompact.length;
        historyForModel = shrinkCompactionHistoryAfterOverflow(
          messagesToCompact,
          overflowShrinkCount,
          estimateMessage,
        );
        if (historyForModel.length === 0) throw error;
        droppedCount += before - historyForModel.length;
        state.retryCount = 0;
        continue;
      }
      const unwrappedError = unwrapErrorCause(error);
      if (
        (error instanceof CompactionTruncatedError ||
          (unwrappedError instanceof APIEmptyResponseError &&
            unwrappedError.finishReason !== 'filtered')) &&
        messagesToCompact.length > 1
      ) {
        if (requestAttempts >= maxAttempts) {
          throw error;
        }
        const reduced = dropOldestMessageAndLeadingToolResults(messagesToCompact);
        droppedCount += messagesToCompact.length - reduced.length;
        historyForModel = reduced;
        state.retryCount = 0;
        continue;
      }
      if (!isRetryableGenerateError(unwrappedError)) {
        throw error;
      }
      if (requestAttempts >= maxAttempts) {
        throw error;
      }
      await sleepForRetry(retryBackoffDelay(state.retryCount), signal);
      state.retryCount += 1;
    }
  }
  if (attempt === undefined) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a usable summary.',
    );
  }
  return { attempt, droppedCount };
}
