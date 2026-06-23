import { createDecorator } from '../../../di';
import type { ModelCapability } from '@moonshot-ai/kosong';

import type { LLMEvent, LLMRequestOverrides } from '../types';

export interface LLMModelContext {
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly reservedContextSize: number | undefined;
  readonly compactionTriggerRatio: number | undefined;
}

export interface ILLMRequester {
  request(overrides?: LLMRequestOverrides, signal?: AbortSignal): AsyncIterable<LLMEvent>;
  getModelContext(): LLMModelContext;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILLMRequester = createDecorator<ILLMRequester>('agentLLMRequesterService');
