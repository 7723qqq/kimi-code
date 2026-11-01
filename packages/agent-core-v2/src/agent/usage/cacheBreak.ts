import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { LlmRequestProjection } from '#/agent/llmRequester/llmRequestOps';
import type { TokenUsage } from '#human/llm/usage';

import type { CacheObservation } from './cacheObservation';

export type CacheBreakCause =
  | 'model_switch'
  | 'effort_switch'
  | 'projection_change'
  | 'prefix_reset'
  | 'unexplained';

export interface CacheBreakSnapshot {
  readonly model: string;
  readonly effort: string;
  readonly projection?: LlmRequestProjection;
  readonly messageCount?: number;
  readonly usage: TokenUsage;
  readonly at: number;
}

export interface CacheBreakObservation {
  readonly cause: CacheBreakCause;
  readonly previous: CacheBreakSnapshot;
  readonly current: CacheBreakSnapshot;
  readonly cacheReadDropRatio: number;
  readonly intervalMs: number;
}

export interface CacheBreakObserveInput {
  readonly usage: TokenUsage;
  readonly cache?: CacheObservation;
  readonly turnId?: number;
  readonly step?: number;
  readonly now?: number;
}

export interface IAgentCacheBreakService {
  readonly _serviceBrand: undefined;

  observe(input: CacheBreakObserveInput): CacheBreakObservation | undefined;
  reset(): void;
}

export const IAgentCacheBreakService: ServiceIdentifier<IAgentCacheBreakService> =
  createDecorator<IAgentCacheBreakService>('agentCacheBreakService');
