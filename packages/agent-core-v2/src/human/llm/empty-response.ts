import type { LlmErrorMessage } from '#human/llm/errors';
import { NO_FINISH, type FinishInfo } from '#human/llm/finish-reason';
import type { AssistantMessage } from '#human/message';
import type { LlmModel } from '#human/llm/model';

function formatFinishReasonHint(finish: FinishInfo): string {
  if (finish.finishReason === null && finish.rawFinishReason === null) return '';
  const raw = finish.rawFinishReason === null ? '' : `, rawFinishReason=${finish.rawFinishReason}`;
  const filteredHint =
    finish.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';
  return ` Provider stop details: finishReason=${finish.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

export function createEmptyResponseError(
  model: LlmModel,
  finish: FinishInfo,
  thinkOnly: boolean,
): LlmErrorMessage<'empty_response'> {
  const detail =
    finish.rawFinishReason === 'repeat'
      ? 'The API stopped the response because it detected repeated output.'
      : thinkOnly
        ? 'The API returned a response containing only thinking content without any text or tool calls. This usually indicates the stream was interrupted or the output token budget was exhausted during reasoning.'
        : 'The API returned an empty response (no content, no tool calls).';
  return {
    kind: 'empty_response',
    message: `${detail}${formatFinishReasonHint(finish)} Provider: ${model.provider}, model: ${model.model}`,
    finishReason: finish.finishReason,
    rawFinishReason: finish.rawFinishReason,
    retryable: finish.finishReason !== 'filtered',
  };
}

export function emptyResponseError(
  message: AssistantMessage,
  model: LlmModel,
  finish: FinishInfo,
): LlmErrorMessage<'empty_response'> | null {
  if (finish.rawFinishReason === 'repeat') {
    return createEmptyResponseError(model, finish, false);
  }
  const hasToolCalls = message.toolCalls.length > 0;
  if (message.content.length === 0 && !hasToolCalls) {
    return createEmptyResponseError(model, finish, false);
  }
  const hasThink = message.content.some((part) => part.type === 'think');
  const hasText = message.content.some(
    (part) => part.type === 'text' && part.text.trim().length > 0,
  );
  if (hasThink && !hasText && !hasToolCalls) {
    return createEmptyResponseError(model, finish, true);
  }
  return null;
}

export function validateStreamCompletion(
  message: AssistantMessage,
  model: LlmModel,
  finish: FinishInfo | undefined,
): LlmErrorMessage<'empty_response' | 'provider'> | null {
  const empty = emptyResponseError(message, model, finish ?? NO_FINISH);
  if (empty !== null) return empty;
  if (finish !== undefined) return null;
  return {
    kind: 'provider',
    message: `The API stream ended without a finish event. Provider: ${model.provider}, model: ${model.model}`,
    retryable: true,
  };
}
