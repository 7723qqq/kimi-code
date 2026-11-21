import type { Message, ToolDescription } from '#human/message';
import type { LlmModel } from '#human/llm/model';
import type { TraitContext } from '#human/llm/protocol/base';
import type { ThinkingStrategy } from '#human/llm/protocol/thinking';
import type { ToolCallIdPolicy, ToolMessageConversion } from '#human/llm/requester/requester';

import type { OpenAIRawChunk, OpenAIRawUsage, OpenAIWireMessage } from './contract';

export interface OpenAITrait {
  readonly reasoningKey?: string;
  readonly toolCallIdPolicy?: ToolCallIdPolicy;
  readonly toolMessageConversion?: ToolMessageConversion;
  readonly strictThinkingValidation?: boolean;

  readonly thinking?: ThinkingStrategy;

  encodeCacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  encodeMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  completionTokensWhenUnset?(input: {
    readonly model: LlmModel;
    readonly usedContextTokens?: number;
  }): number | undefined;

  convertTool?(tool: ToolDescription, ctx: TraitContext): Record<string, unknown> | undefined;

  convertMessage?(
    message: Message,
    converted: OpenAIWireMessage,
    ctx: TraitContext,
  ): OpenAIWireMessage | null;

  mergeHistory?(
    messages: readonly OpenAIWireMessage[],
    ctx: TraitContext,
  ): OpenAIWireMessage[] | undefined;

  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  extractUsage?(chunk: OpenAIRawChunk): OpenAIRawUsage | null | undefined;
}
