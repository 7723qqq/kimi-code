import { createDecorator } from "#/_base/di";
import type { FinishReason, Message, StreamedMessagePart, TokenUsage, Tool } from "@moonshot-ai/kosong";
import type { LLMRequestLogFields } from '#/loop';
import type { UsageRecordContext } from '#/usage';

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  requestLogFields?: LLMRequestLogFields;
  usageContext?: UsageRecordContext;
}

export type LLMEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      /** Provider-assigned response/message id, when available. */
      readonly id?: string;
    }
  | {
      readonly type: 'timing';
      readonly firstTokenLatencyMs: number;
      readonly streamDurationMs: number;
    };

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;
  request(overrides?: LLMRequestOverrides, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>('agentLLMRequesterService');
