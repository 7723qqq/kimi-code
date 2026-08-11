/**
 * `microCompaction` domain — `IAgentMicroCompactionService` contract.
 *
 * Cache-miss micro compaction: after the prompt cache misses (no assistant
 * output for `cacheMissedThresholdMs`) and the context is at least
 * `minContextUsageRatio` full, raise the truncation cutoff to keep only the
 * `keepRecentMessages` tail; the outgoing request then replaces oversized
 * (`>= minContentTokens`) old tool results with `truncatedMarker`. The cutoff
 * persists on the wire and resets on clear / compaction / undo. Bound at
 * Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { ContextMessage } from '#/agent/contextMemory/types';

export interface MicroCompactionConfig {
  /** Number of trailing messages exempt from truncation. */
  keepRecentMessages: number;
  /** Minimum content tokens for a tool result to be truncated. */
  minContentTokens: number;
  /** Idle time (ms) after the last assistant output that counts as a cache miss. */
  cacheMissedThresholdMs: number;
  /** Text marker replacing a truncated tool result. */
  truncatedMarker: string;
  /** Minimum context-window usage ratio for truncation to apply. */
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

  /** Merge a partial configuration into the current one. */
  setConfig(config: Partial<MicroCompactionConfig>): void;

  /** Detect a prompt-cache miss and raise the truncation cutoff. */
  detect(): void;

  /** Replace truncated tool results in an outgoing message view. */
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];

  /** Lower the cutoff (v1 semantics: it can only ever shrink). */
  reset(maxCutoff?: number): void;
}

export const IAgentMicroCompactionService =
  createDecorator<IAgentMicroCompactionService>('agentMicroCompactionService');
