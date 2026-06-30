import { IAgentSwarmService } from '#/swarm';
import type { IAgentSwarmService as AgentSwarmService } from '#/swarm';
import type { ResolvedToolExecutionHookContext } from '#/tool';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';

export class SwarmModeAgentSwarmApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';

  constructor(@IAgentSwarmService private readonly swarm: AgentSwarmService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return undefined;
    return this.swarm.isActive ? { kind: 'approve' } : undefined;
  }
}
