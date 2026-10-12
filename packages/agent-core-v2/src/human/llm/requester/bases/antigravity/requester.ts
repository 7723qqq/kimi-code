import { isAbortError, toLlmErrorMessage, toLlmTransportErrorMessage } from '#/llm/errors';
import type { ProtocolBase } from '#/llm/protocol/base';
import {
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
} from '#/llm/requester/requester';
import { thinkingMetadataOf } from '#/llm/thinking';
import type { Message } from '#human/llm/message';

import { AntigravityChatProvider, getAntigravityModelCapability } from './antigravity';

function sameMessage(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  if (a.content.length !== b.content.length) return false;
  for (let i = 0; i < a.content.length; i++) {
    const left = a.content[i];
    const right = b.content[i];
    if (left === undefined || right === undefined) return false;
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  if (a.role === 'tool' && b.role === 'tool' && a.toolCallId !== b.toolCallId) return false;
  if (a.role === 'assistant' && b.role === 'assistant') {
    if (a.toolCalls.length !== b.toolCalls.length) return false;
    for (let i = 0; i < a.toolCalls.length; i++) {
      const left = a.toolCalls[i];
      const right = b.toolCalls[i];
      if (left === undefined || right === undefined) return false;
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    }
  }
  return true;
}

function extendsMessages(previous: readonly Message[], next: readonly Message[]): boolean {
  if (next.length <= previous.length) return false;
  for (let i = 0; i < previous.length; i++) {
    const before = previous[i];
    const after = next[i];
    if (before === undefined || after === undefined) return false;
    if (!sameMessage(before, after)) return false;
  }
  return true;
}

export function createAntigravityRequester(): LlmRequester {
  let remembered: { id: string; messages: readonly Message[] } | undefined;
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const { onEvent } = control;
      onEvent?.({ type: 'llm.sent' });
      const messages = [...content.messages];
      const resumeFrom =
        remembered !== undefined && extendsMessages(remembered.messages, messages)
          ? remembered.id
          : undefined;
      if (resumeFrom === undefined) remembered = undefined;
      const provider = new AntigravityChatProvider({
        model: config.model.model,
        thinkingEffort:
          thinkingMetadataOf(config.model)?.adaptiveThinking === true ? 'high' : undefined,
      });
      try {
        const streamed = await provider.generate(
          config.systemPrompt ?? '',
          [...(config.tools ?? [])],
          messages,
          { signal: control.signal, conversationId: resumeFrom },
        );
        for await (const part of streamed) {
          onEvent?.({ type: 'llm.streaming.part', part });
        }
        if (streamed.id !== null) {
          onEvent?.({ type: 'llm.streaming.message_id', messageId: streamed.id });
          remembered = { id: streamed.id, messages };
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
        remembered = undefined;
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
