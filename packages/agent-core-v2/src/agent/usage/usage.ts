import type { TokenUsage } from '#/app/llmProtocol';

import { createDecorator } from "#/_base/di";

export interface UsageRecordContext {
  readonly type: 'turn';
  readonly turnId: number;
}

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface IAgentUsageService {
  readonly _serviceBrand: undefined;
  record(model: string, usage: TokenUsage, context?: UsageRecordContext): void;
  status(): UsageStatus;
}

export const IAgentUsageService = createDecorator<IAgentUsageService>('agentUsageService');
