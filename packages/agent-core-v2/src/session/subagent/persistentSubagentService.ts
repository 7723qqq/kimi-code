/**
 * `subagent` domain — `IPersistentSubagentService` implementation.
 *
 * Creates persistent children through `agentLifecycle.create({ binding })`,
 * resolving the profile from `sessionAgentProfileCatalog` and inheriting the
 * caller's model, thinking level, permission mode, and user tools; announces
 * spawns through the `subagent.spawned` wire signal; drives each turn through
 * `ISessionSubagentService.run` wrapped by `mirrorAgentRun` (which fires the
 * run hooks/events and reports usage); and destroys children through
 * `agentLifecycle.remove`. Tracks each child's owner so the flat lifecycle
 * registry's caller ↔ child association stays business data of this domain.
 * Bound at Session scope.
 */

import { Service } from '#/_base/di/service';
import { Error2, ErrorCodes } from '#/errors';
import { t } from '@moonshot-ai/kimi-i18n';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUsageService } from '#/agent/usage/usage';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  IPersistentSubagentService,
  type PersistentSubagentHost,
  type PersistentSubagentSpawnOptions,
} from './persistentSubagent';

export class PersistentSubagentService extends Service implements IPersistentSubagentService {
  declare readonly _serviceBrand: undefined;

  private readonly persistentChildren = new Map<
    string,
    { readonly callerAgentId: string; readonly profileName: string }
  >();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
  ) {
    super();
  }

  bind(callerAgentId: string): PersistentSubagentHost {
    return {
      spawnPersistent: (options) => this.spawnPersistent(callerAgentId, options),
      runDiscussionTurn: (agentId, prompt, signal) =>
        this.runDiscussionTurn(callerAgentId, agentId, prompt, signal),
      getPersistentUsage: (agentId) => this.getPersistentUsage(callerAgentId, agentId),
      destroyPersistent: (agentId) => this.destroyPersistent(callerAgentId, agentId),
    };
  }

  private async spawnPersistent(
    ownerAgentId: string,
    options: PersistentSubagentSpawnOptions,
  ): Promise<string> {
    options.signal.throwIfAborted();
    const caller = this.requireAgent(ownerAgentId, 'Caller agent');
    await this.catalog.ready;
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, t('v2Errors.unknownAgentType', { type: options.profileName }), {
        details: { profileName: options.profileName },
      });
    }
    const callerData = caller.accessor.get(IAgentProfileService).data();
    const child = await this.lifecycle.create({
      binding: {
        profile: profile.name,
        model: callerData.modelAlias,
        thinking: callerData.thinkingLevel,
      },
      labels: subagentLabels(ownerAgentId),
    });
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
      runInBackground: options.runInBackground,
    });
    this.persistentChildren.set(child.id, {
      callerAgentId: ownerAgentId,
      profileName: options.profileName,
    });
    return child.id;
  }

  private async runDiscussionTurn(
    ownerAgentId: string,
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const entry = this.persistentChildren.get(agentId);
    if (entry === undefined || entry.callerAgentId !== ownerAgentId) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, t('v2Errors.subagentNotFound', { agentId }));
    }
    const caller = this.requireAgent(ownerAgentId, 'Caller agent');
    const child = this.requireAgent(agentId, 'Agent instance');
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
    const run = await this.subagents.run(agentId, { kind: 'prompt', prompt }, { signal });
    const { summary } = await mirrorAgentRun(caller, run, {
      profileName: entry.profileName,
      prompt,
      signal,
    });
    return summary;
  }

  private getPersistentUsage(ownerAgentId: string, agentId: string): TokenUsage | undefined {
    const entry = this.persistentChildren.get(agentId);
    if (entry === undefined || entry.callerAgentId !== ownerAgentId) return undefined;
    const child = this.lifecycle.get(agentId);
    if (child === undefined) return undefined;
    return child.accessor.get(IAgentUsageService).status().total;
  }

  private async destroyPersistent(ownerAgentId: string, agentId: string): Promise<void> {
    const entry = this.persistentChildren.get(agentId);
    if (entry === undefined || entry.callerAgentId !== ownerAgentId) return;
    this.persistentChildren.delete(agentId);
    await this.lifecycle.remove(agentId);
  }

  private requireAgent(agentId: string, _label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, t('v2Errors.subagentNotFound', { agentId }), {
        details: { agentId },
      });
    }
    return handle;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IPersistentSubagentService,
  PersistentSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
