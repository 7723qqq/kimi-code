import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class AgentSwarmExclusiveDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';

  private readonly solitaryTools = new Set(['AgentSwarm', 'SwarmDiscussion']);

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolCalls = context.toolCalls;
    const solitaryCount = toolCalls.filter(
      (toolCall) => this.solitaryTools.has(toolCall.name),
    ).length;

    if (solitaryCount === 0) return;
    if (solitaryCount === 1 && toolCalls.length === 1) return;

    return {
      kind: 'deny',
      message:
        solitaryCount > 1
          ? multipleSolitaryDeniedMessage(toolCalls.length > solitaryCount)
          : mixedSolitaryDeniedMessage(),
      reason: {
        solitary_tool_calls: solitaryCount,
        tool_calls: toolCalls.length,
      },
    };
  }
}

function multipleSolitaryDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' These tools also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm/SwarmDiscussion must be called one at a time. Multiple calls are not forbidden, ' +
    'but issue them sequentially: call one, wait for its result, then call the next; ' +
    `or merge the work into a single call when one can cover it.${suffix}`
  );
}

function mixedSolitaryDeniedMessage(): string {
  return (
    'AgentSwarm/SwarmDiscussion must be the only tool call in a model response. ' +
    'Retry with a single call by itself, then call any other tools after it returns.'
  );
}