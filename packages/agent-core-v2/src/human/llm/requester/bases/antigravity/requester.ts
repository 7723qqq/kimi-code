import { isAbortError, toLlmErrorMessage, toLlmTransportErrorMessage } from '#/llm/errors';
import type { ProtocolBase } from '#/llm/protocol/base';
import {
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
} from '#/llm/requester/requester';
import { thinkingMetadataOf } from '#/llm/thinking';

import { AntigravityChatProvider, getAntigravityModelCapability } from './antigravity';

export function createAntigravityRequester(): LlmRequester {
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const { onEvent } = control;
      onEvent?.({ type: 'llm.sent' });
      const provider = new AntigravityChatProvider({
        model: config.model.model,
        thinkingEffort:
          thinkingMetadataOf(config.model)?.adaptiveThinking === true ? 'high' : undefined,
      });
      try {
        const streamed = await provider.generate(
          config.systemPrompt ?? '',
          [...(config.tools ?? [])],
          [...content.messages],
          { signal: control.signal },
        );
        for await (const part of streamed) {
          onEvent?.({ type: 'llm.streaming.part', part });
        }
        if (streamed.id !== null) {
          onEvent?.({ type: 'llm.streaming.message_id', messageId: streamed.id });
        }
        if (streamed.usage !== null) {
          onEvent?.({ type: 'llm.streaming.usage', usage: streamed.usage });
        }
        onEvent?.({
          type: 'llm.streaming.finish',
          finish: {
            finishReason: streamed.finishReason,
            rawFinishReason: streamed.rawFinishReason,
          },
        });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: isAbortError(error)
            ? toLlmErrorMessage(error)
            : toLlmTransportErrorMessage(error instanceof Error ? error.message : String(error)),
        });
        return;
      }
      onEvent?.({ type: 'llm.done' });
    },
  };
}

export function createAntigravityBase(): ProtocolBase {
  return {
    capability: getAntigravityModelCapability,
    createRequester: () => createAntigravityRequester(),
  };
}

export const antigravityBase: ProtocolBase = createAntigravityBase();
