import { retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { createUserMessage, type Message } from '#/app/llmProtocol/message';
import type { ToolDescription as CoreToolDescription } from '@moonshot-ai/core/llm/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { FullLoopLlmRequester } from '@moonshot-ai/core/loop/index';
import type { LlmRequestModel } from '@moonshot-ai/core/llm/request';
import { historyFromContext } from '#/agent/loop/history';
import { runOperationRequest } from '#/agent/loop/operationRequest';
import { unwrapErrorCause } from '#/errors';
import { usageFromCore } from '#human/llm/usage';

import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  collectSummary,
  CompactionTruncatedError,
  shrinkCompactionHistoryAfterOverflow,
  snipLargeToolResults,
  type CompactionAttemptResult,
  type HistoryTokenProfile,
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
  readonly tokenProfile: HistoryTokenProfile;
  readonly tools?: readonly CoreToolDescription[];
  readonly getEffectiveMaxContextTokens: () => number;
  readonly llmRequester: FullLoopLlmRequester;
  readonly resolveMaxOutputTokens: (maxOutputSize?: number) => LlmRequestModel['maxOutputTokens'];
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
    tokenProfile,
    tools,
    getEffectiveMaxContextTokens,
    llmRequester,
    resolveMaxOutputTokens,
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
  while (true) {
    const messagesToCompact = historyForModel;
    const snipped = snipLargeToolResults(messagesToCompact);
    const messages: Message[] = [...snipped, createUserMessage(instruction)];
    const estimatedCompactionRequestTokens = tokenProfile.estimateRequest(messages);
    const effectiveMaxTokens = getEffectiveMaxContextTokens();
    const usedContextTokens =
      effectiveMaxTokens > 0
        ? estimatedCompactionRequestTokens +
          Math.ceil(effectiveMaxTokens * COMPLETION_BUDGET_ESTIMATE_MARGIN_RATIO)
        : undefined;
    const outputSqueezedByWindow =
      effectiveMaxTokens > 0 &&
      usedContextTokens !== undefined &&
      compactionMaxOutputSize !== undefined &&
      effectiveMaxTokens - usedContextTokens < compactionMaxOutputSize;
    requestAttempts += 1;

    try {
      const runRequest = async () => {
        const outcome = await runOperationRequest(
          llmRequester,
          {
            messages: historyFromContext(messages),
            profile: tools === undefined
              ? undefined
              : { tools },
            maxOutputTokens: resolveMaxOutputTokens(compactionMaxOutputSize),
            usedContextTokens,
            attributes: {
              kind: 'compaction',
              ...(originTurnId === undefined ? {} : { turnId: originTurnId }),
              logFields: { droppedCount },
              ...(cacheProbePending ? { promptCacheProbe: 'compaction' as const } : {}),
            },
          },
          { signal, onRequestId: (requestId) => setTrace({ requestId }) },
        );
        return {
          message: outcome.message,
          usage: usageFromCore(outcome.usage),
          traceId: outcome.requestId,
          providerFinishReason: outcome.finish?.finishReason ?? undefined,
        };
      };
      const result = await runRequest();
      cacheProbePending = false;
      attempt = collectSummary(result);
      break;
    } catch (error) {
      const isContextOverflow = shouldRecoverFromContextOverflow(
        error,
        estimatedCompactionRequestTokens,
      );
      const truncatedForLackOfRoom =
        error instanceof CompactionTruncatedError && outputSqueezedByWindow;
      if (isContextOverflow || truncatedForLackOfRoom) {
        if (isContextOverflow) observeContextOverflow(estimatedCompactionRequestTokens);
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
          tokenProfile.estimateMessage,
        );
        if (historyForModel.length === 0) throw error;
        droppedCount += before - historyForModel.length;
        state.retryCount = 0;
        continue;
      }
      const unwrappedError = unwrapErrorCause(error);
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
