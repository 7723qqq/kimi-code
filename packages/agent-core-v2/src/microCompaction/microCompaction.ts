/**
 * `microCompaction` domain (L4) - micro-compaction service contract.
 *
 * Defines the truncation tuning model and the Agent-scoped
 * `IMicroCompactionService` used by context projection. Bound at Agent scope.
 */

import { createDecorator } from "#/_base/di";
import type { ContextMessage } from '#/contextMemory';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

export interface MicroCompactionEffect {
  readonly truncatedToolResultCount: number;
  readonly truncatedToolResultTokensBefore: number;
  readonly truncatedToolResultTokensAfter: number;
}

export interface IMicroCompactionService {
  readonly _serviceBrand: undefined;
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];
}

export const IMicroCompactionService =
  createDecorator<IMicroCompactionService>('agentMicroCompactionService');
