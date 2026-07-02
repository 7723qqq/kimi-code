/**
 * `agent` domain (L2) — agent-scope identity token.
 *
 * Exposes `IAgentScopeContext`, the identity of the current agent scope (its
 * `agentId`). Seeded into every agent scope at creation by `agentLifecycle`
 * so Agent-scoped consumers can refer to themselves (for example as the
 * parent of a subagent) without threading the id through every call site.
 * Bound at Agent scope via a per-agent seed, not the scoped registry.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentScopeContext {
  readonly _serviceBrand: undefined;
  readonly agentId: string;
}

export const IAgentScopeContext: ServiceIdentifier<IAgentScopeContext> =
  createDecorator<IAgentScopeContext>('agentScopeContext');
