import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from './subagentHost';
import {
  ISubagentHost,
} from './subagentHost';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class SubagentHostService implements ISubagentHost {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  getSwarmItem(agentId: string): string | undefined {
    return this.subagentHost?.getSwarmItem(agentId);
  }

  startBtw(): Promise<string> {
    return this.subagentHost.startBtw();
  }

  async generateAgentsMd(): Promise<void> {
    const handle = await this.subagentHost.spawn({
      profileName: 'coder',
      parentToolCallId: 'generate-agents-md',
      prompt: 'Initialize AGENTS.md for this workspace.',
      description: 'Initialize AGENTS.md',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;
  }

  runQueued<T>(
    tasks: readonly QueuedSubagentTask<T>[],
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const subagentHost = this.subagentHost;
    if (subagentHost === undefined) {
      throw new Error('Subagent host is not configured.');
    }
    return subagentHost.runQueued(tasks);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISubagentHost,
  SubagentHostService,
  InstantiationType.Delayed,
  'subagentHost',
);
