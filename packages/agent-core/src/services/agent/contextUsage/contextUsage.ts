import type { TokenUsage } from '@moonshot-ai/kosong';

import { createDecorator } from '../../../di';
import type { CompactionResult } from '../../../agent/compaction';

export interface ContextTokenStatus {
  readonly contextTokens: number;
  readonly contextTokensWithPending: number;
}

export interface IContextUsageService {
  readonly _serviceBrand: undefined;

  getStatus(): ContextTokenStatus;
  coverThrough(indexExclusive: number, usage?: TokenUsage): void;
  applyCompactionResult(result: Pick<CompactionResult, 'tokensAfter'>): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IContextUsageService =
  createDecorator<IContextUsageService>('agentContextUsageService');
