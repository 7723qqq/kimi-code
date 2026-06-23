import { createDecorator } from '../../../di';
import type { ExperimentalFlagResolver } from '../../../flags';

import type { ContextMessage } from '../types';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

export interface MicroCompactionServiceOptions {
  readonly config?: Partial<MicroCompactionConfig>;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly now?: () => number;
  readonly maxContextTokens?: () => number | undefined;
}

export interface MicroCompactionEffect {
  readonly truncatedToolResultCount: number;
  readonly truncatedToolResultTokensBefore: number;
  readonly truncatedToolResultTokensAfter: number;
}

export interface IMicroCompactionService {
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];
}

export type MicroCompactionTelemetryProperties = MicroCompactionConfig
  & MicroCompactionEffect
  & {
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly previous_cutoff: number;
    readonly cutoff: number;
    readonly message_count: number;
    readonly cache_age_ms: number;
  };

declare module '../types' {
  interface AgentEventMap {
    'micro_compaction.finished': {
      properties: MicroCompactionTelemetryProperties;
    };
  }

  interface WireRecordMap {
    'micro_compaction.apply': {
      cutoff: number;
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMicroCompactionService =
  createDecorator<IMicroCompactionService>('agentMicroCompactionService');
