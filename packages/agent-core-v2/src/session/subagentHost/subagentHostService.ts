import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
  SpawnSubagentOptions,
  RunSubagentOptions,
  SubagentHandle,
} from './subagentHost';
import type { SubagentSuspendedEvent } from './subagent-batch';
import {
  ISessionSubagentHost,
} from './subagentHost';
import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IAgentBackgroundService } from '#/agent/background';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IKaos } from '#/app/kaos';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionMetadata } from '#/session/session-metadata';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { AgentTool } from './agentTool';
import { DefaultSessionSubagentHost } from './defaultSessionSubagentHost';
import { DEFAULT_AGENT_SUBAGENT_PROFILES } from './profiles';

export class SessionSubagentHostService extends Disposable implements ISessionSubagentHost {
  declare readonly _serviceBrand: undefined;

  private readonly host: SessionSubagentHost;

  constructor(
    subagentHost: SessionSubagentHost | undefined,
    @IAgentLifecycleService agents: IAgentLifecycleService,
    @ISessionMetadata metadata: ISessionMetadata,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @IAgentProfileService profile: IAgentProfileService,
    @IKaos kaos: IKaos,
    @ISessionProcessRunner runner: ISessionProcessRunner,
    @ILogService log?: ILogService,
  ) {
    super();
    this.host = subagentHost ?? new DefaultSessionSubagentHost(agents, 'main', metadata);

    this._register(
      toolRegistry.register(
        new AgentTool(this, background, DEFAULT_AGENT_SUBAGENT_PROFILES, {
          log,
          gitContext: { cwd: kaos.cwd, runner },
          canRunInBackground: () => {
            return profile.isToolActive('TaskList') &&
              profile.isToolActive('TaskOutput') &&
              profile.isToolActive('TaskStop');
          },
        }),
      ),
    );
  }

  getSwarmItem(agentId: string): string | undefined {
    return this.host?.getSwarmItem(agentId);
  }

  startBtw(): Promise<string> {
    return this.host.startBtw();
  }

  async generateAgentsMd(): Promise<void> {
    const handle = await this.host.spawn({
      profileName: 'coder',
      parentToolCallId: 'generate-agents-md',
      prompt: 'Initialize AGENTS.md for this workspace.',
      description: 'Initialize AGENTS.md',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;
  }

  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    return this.host.spawn(options);
  }

  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    return this.host.resume(agentId, options);
  }

  getProfileName(agentId: string): Promise<string | undefined> {
    return this.host.getProfileName(agentId);
  }

  markActiveChildDetached(agentId: string): void {
    this.host.markActiveChildDetached(agentId);
  }

  cancelAll(reason?: unknown): void {
    this.host.cancelAll(reason);
  }

  suspended(event: SubagentSuspendedEvent): void {
    this.host.suspended(event);
  }

  runQueued<T>(
    tasks: readonly QueuedSubagentTask<T>[],
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const subagentHost = this.host;
    if (subagentHost === undefined) {
      throw new Error('Subagent host is not configured.');
    }
    return subagentHost.runQueued(tasks);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentHost,
  SessionSubagentHostService,
  InstantiationType.Delayed,
  'subagentHost',
);
