import type { AgentTask, AgentTaskInfoBase, AgentTaskSink } from '#/agent/task/types';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';

/** The engine's completion verdict for one native background agent. */
export interface NativeBackgroundOutcome {
  readonly result: string;
  readonly error?: string;
}

/**
 * Host-side registration for an engine-native background subagent (P58):
 * the engine runs the turn detached and reports the outcome over the
 * `subagent.completed` / `subagent.failed` lifecycle events; this task
 * bridges that async outcome into the host task system so the usual
 * settle → notification → synthetic-turn path applies unchanged.
 */
export class NativeBackgroundAgentTask implements AgentTask {
  readonly idPrefix = 'agent';
  readonly kind = 'agent' as const;

  constructor(
    private readonly agentId: string,
    private readonly subagentType: string,
    private readonly parentToolCallId: string,
    readonly description: string,
    private readonly completion: Promise<NativeBackgroundOutcome>,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    const outcome = await this.completion;
    if (outcome.error !== undefined) {
      await sink.settle({ status: 'failed', stopReason: outcome.error });
      return;
    }
    sink.appendOutput(outcome.result);
    await sink.settle({ status: 'completed' });
  }

  toInfo(base: AgentTaskInfoBase): SubagentTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
      parentToolCallId: this.parentToolCallId,
    };
  }
}
