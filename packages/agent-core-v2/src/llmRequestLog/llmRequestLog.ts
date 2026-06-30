import type { ChatProvider, Message, Tool } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";
import type { LLMRequestLogFields } from '#/loop';

export interface LLMRequestLogInput {
  readonly provider: ChatProvider;
  readonly modelAlias?: string;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: LLMRequestLogFields;
}

export interface IAgentLLMRequestLogService {
  readonly _serviceBrand: undefined;

  logRequest(input: LLMRequestLogInput): void;
}

export const IAgentLLMRequestLogService =
  createDecorator<IAgentLLMRequestLogService>('agentLLMRequestLogService');
