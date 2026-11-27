import type { LlmRetryOptions } from '@moonshot-ai/core/llm/policy/retry';
import type { Message } from '@moonshot-ai/core/llm/message';
import type {
  LlmRequestAttributes,
  LlmRequestModel,
  LlmRequestProfile,
} from '@moonshot-ai/core/llm/request';
import { llmErrorRequestId, type LlmErrorMessage, type LlmOutcome } from '@moonshot-ai/core/llm/response';
import type { FullLoopLlmRequester } from '@moonshot-ai/core/loop/index';
import { ChatProviderError, errorFromLlmMessage } from '#/llm-adapter/contract/errors';
import { apiRequestId } from '#/agent/loop/requestObservation';

export interface OperationRequestInput {
  readonly messages: readonly Message[];
  readonly profile?: LlmRequestProfile;
  readonly maxOutputTokens?: LlmRequestModel['maxOutputTokens'];
  readonly usedContextTokens?: number;
  readonly attributes?: LlmRequestAttributes;
  readonly retry?: LlmRetryOptions;
}

export interface OperationRequestControl {
  readonly signal?: AbortSignal;
  readonly onRequestId?: (requestId: string) => void;
}

export type OperationRequestOutcome = Extract<LlmOutcome, { type: 'done' }>;

function requestIdFromFields(fields: {
  readonly requestId?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly error?: LlmErrorMessage;
}): string | undefined {
  const headerId = fields.headers?.['x-request-id'] ?? fields.headers?.['x-trace-id'];
  const errorId = fields.error === undefined
    ? undefined
    : (llmErrorRequestId(fields.error) ?? apiRequestId(fields.error));
  return fields.requestId ?? (headerId && headerId.length > 0 ? headerId : undefined) ?? errorId;
}

export async function runOperationRequest(
  requester: FullLoopLlmRequester,
  input: OperationRequestInput,
  control: OperationRequestControl = {},
): Promise<OperationRequestOutcome> {
  const signal = control.signal ?? new AbortController().signal;
  const outcome = await requester.with({
    model: input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens },
    content: {
      messages: input.messages,
      ...(input.usedContextTokens === undefined ? {} : { usedTokens: input.usedContextTokens }),
    },
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
    policy: { retry: input.retry ?? { maxAttemptsPerStep: 1 } },
  }).generate({}, {
    signal,
    onEvent: (event) => {
      if (event.type === 'llm.delta.request_id' && event.requestId !== undefined) {
        control.onRequestId?.(event.requestId);
      } else if (event.type === 'llm.retry') {
        const requestId = requestIdFromFields(event);
        if (requestId !== undefined) control.onRequestId?.(requestId);
      } else if (event.type === 'llm.ended') {
        const requestId = requestIdFromFields(
          event.outcome.type === 'failed'
            ? { requestId: event.outcome.requestId, headers: event.outcome.headers, error: event.outcome.error }
            : { requestId: event.outcome.requestId, headers: event.outcome.headers },
        );
        if (requestId !== undefined) control.onRequestId?.(requestId);
      }
    },
  });
  if (outcome.type === 'done') return outcome;
  const requestId = requestIdFromFields(
    outcome.type === 'failed'
      ? { requestId: outcome.requestId, headers: outcome.headers, error: outcome.error }
      : { requestId: outcome.requestId, headers: outcome.headers },
  );
  if (requestId !== undefined) control.onRequestId?.(requestId);
  if (outcome.type === 'aborted') {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  if (
    outcome.error.kind === 'provider' &&
    outcome.rawError instanceof Error &&
    !(outcome.rawError instanceof ChatProviderError)
  ) {
    throw outcome.rawError;
  }
  throw errorFromLlmMessage(outcome.error as Parameters<typeof errorFromLlmMessage>[0]);
}
