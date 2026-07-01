/**
 * `agentTool` domain (L5) — `IAgentToolService` token.
 *
 * Exposes only the service identifier for the Agent-scoped `Agent` tool
 * registrar so consumers (for example `runChildAgent`, which force-instantiates
 * it for child agents, and `rpc`, which force-instantiates it for the main
 * agent) can resolve the binding without pulling in the registrar's import
 * graph. Kept separate from the implementation to avoid an import cycle through
 * `agentTool` → `runChildAgent`. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentToolService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolService: ServiceIdentifier<IAgentToolService> =
  createDecorator<IAgentToolService>('agentToolService');
