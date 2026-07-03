/**
 * `agentTool` domain (L5) — hook service for the `Agent` collaboration tool.
 *
 * Exposes the Agent-scoped subagent lifecycle hooks that the `Agent` tool and
 * swarm scheduler emit, and that observer services such as `externalHooks`
 * consume. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Hooks } from '#/hooks';

export interface AgentToolWillRunSubagentContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentToolDidRunSubagentContext {
  readonly agentName: string;
  readonly response: string;
}

export interface IAgentToolService {
  readonly _serviceBrand: undefined;
  readonly hooks: Hooks<{
    onWillRunSubagent: AgentToolWillRunSubagentContext;
    onDidRunSubagent: AgentToolDidRunSubagentContext;
  }>;
}

export const IAgentToolService: ServiceIdentifier<IAgentToolService> =
  createDecorator<IAgentToolService>('agentToolService');
