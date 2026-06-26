import type { TokenUsage } from '@moonshot-ai/kosong';

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

export interface IUsageService {
  record(model: string, usage: TokenUsage, context?: UsageRecordContext): void;
  status(): UsageStatus;
}

export const IUsageService = createDecorator<IUsageService>('usageService.agent');
