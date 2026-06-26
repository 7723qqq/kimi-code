import type { TokenUsage } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";

export type UsageRecordScope = 'session' | 'turn';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface IUsageService {
  record(model: string, usage: TokenUsage, scope?: UsageRecordScope): void;
  status(): UsageStatus;
}

export const IUsageService = createDecorator<IUsageService>('usageService.agent');
