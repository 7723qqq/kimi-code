/**
 * `microCompaction` domain (L4) - micro-compaction service contract.
 *
 * Defines the Agent-scoped `IAgentMicroCompactionService` used by context
 * projection. Bound at Agent scope.
 */

import { createDecorator } from "#/_base/di/instantiation";
import type { ContextMessage } from '#/agent/contextMemory/types';

export interface IAgentMicroCompactionService {
  readonly _serviceBrand: undefined;

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[];
}

export const IAgentMicroCompactionService =
  createDecorator<IAgentMicroCompactionService>('agentMicroCompactionService');
