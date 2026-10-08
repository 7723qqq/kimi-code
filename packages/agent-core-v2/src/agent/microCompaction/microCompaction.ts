import { createDecorator } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

export const DEFAULT_MICRO_COMPACTION_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

export interface IAgentMicroCompactionService {
  readonly _serviceBrand: undefined;

  readonly config: MicroCompactionConfig;

  setConfig(config: Partial<MicroCompactionConfig>): void;

  detect(): void;

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];

  reset(maxCutoff?: number): void;
}

export const IAgentMicroCompactionService = createDecorator<IAgentMicroCompactionService>(
  'agentMicroCompactionService',
);
