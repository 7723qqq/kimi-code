import type { TokenUsage } from '#/app/llmProtocol';

import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';

type AgentTaskCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

/** Handle to an agent run launched by the `Agent` tool (or swarm). */
export type AgentTaskHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly completion: Promise<AgentTaskCompletion>;
};

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** Agent identifier accepted by Agent(resume=...). */
  readonly agentId?: string;
  /** Profile name of the agent. Wire DTO field name kept for compatibility. */
  readonly subagentType?: string;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create a `taskService.run()`-compatible executor that waits for an
 * agent-run completion promise.  Resolves with the agent's result on
 * success, throws on abort or failure.
 */
export function createAgentExecutor(
  handle: AgentTaskHandle,
  abortController: AbortController,
): (signal: AbortSignal, output: (data: string) => void) => Promise<AgentTaskCompletion> {
  return async (signal, output) => {
    const requestAbort = (): void => {
      abortController.abort(signal.reason);
    };
    if (signal.aborted) {
      requestAbort();
    } else {
      signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await handle.completion;
      output(outcome.result);
      return outcome;
    } catch (error: unknown) {
      if (signal.aborted && (isAbortError(error) || error === signal.reason)) {
        throw error;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', requestAbort);
    }
  };
}

export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;

  constructor(
    private readonly handle: AgentTaskHandle,
    readonly description: string,
    private readonly abortController: AbortController,
  ) {
    this.agentId = handle.agentId;
    this.subagentType = handle.profileName;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abortController.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await this.handle.completion;
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
    };
  }
}
