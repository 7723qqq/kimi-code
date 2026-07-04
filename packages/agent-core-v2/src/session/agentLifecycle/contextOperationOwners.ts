/**
 * `agentLifecycle` domain (L6) — restore preamble for context operations.
 *
 * Wire-log restore replays `context.<type>` records through the operations
 * registered on `contextMemory`, and most owners are Delayed services whose
 * registration only happens on first resolution. Every restore path must
 * resolve the owning services first, otherwise the restore fails loudly on
 * the first unclaimed `context.*` record. This helper concentrates the owner
 * list so restore call sites don't each maintain their own.
 *
 * Not a Service: a pure composition helper over the agent handle.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextOpsService } from '#/agent/contextOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction';
import { IAgentPromptService } from '#/agent/prompt';

/**
 * Resolve every service that defines a context operation, so all
 * `context.<type>` resumers are registered before `restore()` replays the
 * wire log.
 */
export function resolveContextOperationOwners(agent: IAgentScopeHandle): void {
  // `context.append` / `context.replace` / `context.remove` / `context.clear`.
  agent.accessor.get(IAgentContextOpsService);
  // `context.undo`.
  agent.accessor.get(IAgentPromptService);
  // `context.compact` (Eager — resolved here for completeness).
  agent.accessor.get(IAgentFullCompactionService);
}
