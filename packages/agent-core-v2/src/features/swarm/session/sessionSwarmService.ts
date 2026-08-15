/**
 * `sessionSwarm` domain — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks one `AbortController` per caller so `cancel` can abort
 * every in-flight run. The caller ↔ child association is this domain's own
 * business data: requester-side display facts (`subagent.spawned` wire signals
 * carrying the swarm's tool-call context, `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted from this layer; the
 * lifecycle registry itself stays flat. Spawn tasks may carry a concrete
 * `binding` resolved by the caller; without
 * one, spawns inherit the caller agent's model and thinking level. Spawn
 * bindings are resolved through the model catalog before lifecycle allocation.
 * Resumed agents keep the model recorded in their own wire journal — with
 * per-subagent models there is no "child follows the parent's current model"
 * invariant to enforce. Bound at Session scope — contributed into every
 * Session scope by `SwarmFeature` (`features/swarm/swarmFeature`).
 */

import { t } from '@moonshot-ai/kimi-i18n';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { linkAbortSignal } from '#/_base/utils/abort';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  assertSubagentDepthAllowed,
  isSubagentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { wrapSubagentModelError } from '#/session/subagent/configSection';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  resolveSwarmMaxConcurrency,
  AgentRunBatch,
  type AgentRunAttemptOptions,
  type AgentSpawnAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunAttemptHandle,
} from './agentRunBatch';
import type { ISessionSwarmService } from './sessionSwarm';
import {
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': SubagentSuspendedEvent;
  }
}

const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, Set<AbortController>>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {}

  async getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined> {
    const meta = await this.agentMeta(args.agentId);
    if (!isSubagentMeta(meta)) return undefined;
    if (subagentParentAgentId(meta) !== args.callerAgentId) return undefined;
    return subagentSwarmItem(meta);
  }

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    const { callerAgentId, tasks } = args;
    const controller = new AbortController();
    const controllers = this.inFlight.get(callerAgentId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.inFlight.set(callerAgentId, controllers);
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.get(callerAgentId);
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency }).run();
    void promise.finally(() => {
      for (const unlink of unlinks) unlink();
      const controllers = this.inFlight.get(callerAgentId);
      controllers?.delete(controller);
      if (controllers !== undefined && controllers.size === 0) {
        this.inFlight.delete(callerAgentId);
      }
    });
    return promise;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    for (const controller of this.inFlight.get(callerAgentId) ?? []) controller.abort();
  }

  private async spawnAttempt(
    callerAgentId: string,
    options: AgentSpawnAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    await this.catalog.ready;
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error2(
        ErrorCodes.PROFILE_UNKNOWN,
        t('v2Errors.unknownAgentType', { type: options.profileName }),
        {
          details: { profileName: options.profileName },
        },
      );
    }
    const callerData = caller.accessor.get(IAgentProfileService).data();
    if (callerData.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, t('v2Errors.callerAgentNoModel'), {
        details: { agentId: callerAgentId },
      });
    }
    const callerMeta = (await this.metadata.read()).agents?.[callerAgentId];
    const nextDepth = assertSubagentDepthAllowed(callerMeta);
    const binding = options.binding ?? {
      model: callerData.modelAlias,
      thinking: callerData.thinkingLevel,
    };
    let child: IAgentScopeHandle;
    try {
      this.modelCatalog.get(binding.model);
      child = await this.lifecycle.create({
        binding: {
          profile: profile.name,
          model: binding.model,
          thinking: binding.thinking,
        },
        labels: subagentLabels(callerAgentId, {
          swarmItem: options.swarmItem,
          depth: nextDepth,
        }),
      });
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, callerData.modelAlias);
    }
    child.accessor
      .get(IAgentPermissionModeService)
      .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
    child.accessor
      .get(IAgentUserToolService)
      .inheritUserTools(caller.accessor.get(IAgentUserToolService));
    emitAgentRunSpawned(caller, child.id, {
      profileName: options.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      model: binding.model,
    });
    const promptText = await applyProfilePromptPrefix(profile, options.prompt, {
      cwd: this.sessionContext.cwd,
      runner: this.processRunner,
      log: this.log,
    });
    return this.observe(
      caller,
      child.id,
      options.profileName,
      {
        kind: 'prompt',
        prompt: promptText,
      },
      options,
    );
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    await this.requireOwnedSubagent(callerAgentId, agentId);
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = this.requireHandle(agentId, 'Agent instance');
    this.requireIdleSubagent(agentId, child);
    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_PROFILE_FALLBACK;
    if (!retryTurn) {
      const resumedModel = child.accessor.get(IAgentProfileService).data().modelAlias;
      emitAgentRunSpawned(caller, agentId, {
        profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
        model: resumedModel,
      });
    }
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child.id, profileName, request, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    const run = await this.subagents.run(agentId, request, {
      signal: options.signal,
      onReady: options.onReady,
    });
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private requireHandle(agentId: string, _label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, t('v2Errors.subagentNotFound', { agentId }), {
        details: { agentId },
      });
    }
    return handle;
  }

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<void> {
    const meta = await this.agentMeta(agentId);
    if (!isSubagentMeta(meta)) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_A_SUBAGENT,
        t('v2Errors.subagentNotSubagent', { agentId }),
        {
          details: { agentId },
        },
      );
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId } },
      );
    }
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;
