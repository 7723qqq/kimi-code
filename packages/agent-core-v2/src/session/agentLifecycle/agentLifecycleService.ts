/**
 * `agentLifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes. Seeds each agent's
 * identity through `agent` scopeContext, wires per-agent wire records, blob
 * store, and MCP, and registers the agent in the session registry. Bound at
 * Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap';
import { IPluginSessionStartInjectorService } from '#/agent/contextInjector';
import { ILogService } from '#/app/log';
import { IAgentProfileCatalogService, type AgentProfileDefinition } from '#/app/agentProfileCatalog';
import { ITelemetryService } from '#/app/telemetry';
import { AgentMcpService, IAgentMcpService } from '#/agent/mcp';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { resolveSessionMcpConfig } from '#/agent/mcp/session-config';
import { IPluginService } from '#/app/plugin';
import { ISessionContext } from '#/session/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentRecordService } from '#/agent/record';
import { IAgentBuiltinToolsRegistrar } from '#/agent/toolRegistry';
import { IAgentWireRecordService, AgentWireRecordService } from '#/agent/wireRecord';
import { IAgentBlobService, AgentBlobServiceImpl } from '#/agent/blob';
import {
  IAgentExternalHooksService,
  AgentExternalHooksService,
} from '#/agent/externalHooks';

import {
  type AgentListFilter,
  type CreateAgentOptions,
  IAgentLifecycleService,
  type ResumeSubagentOptions,
  type RunSubagentOptions,
  type SpawnAgentOptions,
  type SubagentRunHandle,
} from './agentLifecycle';
import { applyProfileToAgent } from './applyProfileToAgent';
import { observeChildAgentTurn } from './observeChildAgentTurn';
import { ISessionProcessRunner } from '#/session/process';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private mcpManager: McpConnectionManager | undefined;

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IPluginService private readonly plugins: IPluginService,
    @ILogService private readonly log: ILogService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
  ) {
    super();
  }

  async create(opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
    // Per-agent homedir → the wire-record persistence key (`hashKey(homedir)`).
    // Bootstrap computes it under the session dir, mirroring v1's
    // `<sessionDir>/agents/<id>`; business code never assembles the path itself.
    const agentHomedir = this.bootstrap.agentHomedir(
      this.ctx.workspaceId,
      this.ctx.sessionId,
      agentId,
    );
    const agentScope = this.bootstrap.agentScope(
      this.ctx.workspaceId,
      this.ctx.sessionId,
      agentId,
    );
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        extra: [
          [
            IAgentScopeContext,
            {
              _serviceBrand: undefined,
              agentId,
              scope: (subKey?: string): string =>
                subKey === undefined || subKey === '' ? agentScope : `${agentScope}/${subKey}`,
            } satisfies IAgentScopeContext,
          ],
          [IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService, [{ homedir: agentHomedir }])],
          [IAgentBlobService, new SyncDescriptor(AgentBlobServiceImpl, [{}])],
          [IAgentMcpService, new SyncDescriptor(AgentMcpService, [{ manager: this.getMcpManager() }])],
          // External hooks carries a leading static `options` param; the scoped
          // registry supplies none, so seed an empty one to satisfy the DI
          // contract (static args must fill the slots before the first `@IX`).
          // It is force-instantiated below to attach listeners before the first
          // turn.
          [IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService, [{}])],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    // Record the agent in the session registry so a closed-session fork can
    // enumerate every agent and relocate its wire log.
    await this.sessionMetadata.registerAgent(agentId, {
      homedir: agentHomedir,
      forkedFrom: opts.forkedFrom,
      swarmItem: opts.swarmItem,
    });
    this.onDidCreateEmitter.fire(handle);
    // Force-instantiate the Eager builtin-tools registrar: its constructor
    // consumes every module-level `registerTool(...)` contribution and
    // registers each built-in tool (with `@IX` dependencies resolved against
    // this scope) into the per-agent `IAgentToolRegistryService`. Must happen
    // before the first turn — otherwise the LLM sees an empty tool list. The
    // registrar is separate from the registry itself to avoid a construction
    // cycle where tool ctors transitively depend on the registry.
    handle.accessor.get(IAgentBuiltinToolsRegistrar);
    // Force-instantiate the external hook adapter so it registers listeners on
    // the agent's domain hooks before the first turn. No business service
    // injects it directly; it observes their hooks instead.
    handle.accessor.get(IAgentExternalHooksService);
    // Force-instantiate the agent's MCP service so it attaches the (shared)
    // manager's tools and registers the `wait-for-initial-load` hook before the
    // first turn — otherwise plugin/session MCP servers would connect but their
    // tools would never register until something explicitly requests the service.
    handle.accessor.get(IAgentMcpService);
    return handle;
  }

  async createMain(): Promise<IAgentScopeHandle> {
    const handle = await this.create({ agentId: 'main' });
    // Force-instantiate the plugin session-start injector so it registers its
    // turn-cadence injection before the first turn. Main-agent only, matching
    // v1's `pluginSessionStarts: type === 'main' ? ... : undefined`.
    handle.accessor.get(IPluginSessionStartInjectorService);
    return handle;
  }

  async clone(sourceAgentId: string): Promise<IAgentScopeHandle> {
    const source =
      this.handles.get(sourceAgentId) ??
      (sourceAgentId === 'main' ? await this.createMain() : undefined);
    if (source === undefined) throw new Error(`Source agent "${sourceAgentId}" does not exist`);
    const child = await this.create({ forkedFrom: source.id });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    child.accessor.get(IAgentProfileService).update({
      modelAlias: sourceData.modelAlias,
      thinkingLevel: sourceData.thinkingLevel,
      systemPrompt: sourceData.systemPrompt,
      activeToolNames: sourceData.activeToolNames,
    });

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.splice(0, 0, sourceMessages);
    }
    return child;
  }

  async spawn(parentAgentId: string, opts?: SpawnAgentOptions): Promise<IAgentScopeHandle> {
    const parent = this.handles.get(parentAgentId);
    if (parent === undefined) throw new Error(`Parent agent "${parentAgentId}" does not exist`);
    const parentData = parent.accessor.get(IAgentProfileService).data();
    const child = await this.create({
      agentId: opts?.agentId,
      forkedFrom: parentAgentId,
      cwd: opts?.cwd ?? parentData.cwd,
      swarmItem: opts?.swarmItem,
    });
    child.accessor.get(IAgentProfileService).update({
      cwd: opts?.cwd ?? parentData.cwd,
      modelAlias: parentData.modelAlias,
      thinkingLevel: parentData.thinkingLevel,
      systemPrompt: parentData.systemPrompt,
      activeToolNames: parentData.activeToolNames,
    });
    return child;
  }

  /**
   * One shared `McpConnectionManager` per session (built lazily, cached). All
   * agents in the session share it, matching v1's session-scoped MCP and
   * avoiding a reconnect storm per subagent. Connects the session-config
   * servers merged with enabled plugin MCP servers (fire-and-forget; the
   * manager's `initialLoad` gates tool use via `waitForInitialLoad`).
   */
  private getMcpManager(): McpConnectionManager {
    if (this.mcpManager !== undefined) return this.mcpManager;
    const manager = new McpConnectionManager({ log: this.log });
    this.mcpManager = manager;
    this._register({ dispose: () => void manager.shutdown() });
    void this.connectMcpServers(manager).catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
    return manager;
  }

  private async connectMcpServers(manager: McpConnectionManager): Promise<void> {
    const [base, pluginServers] = await Promise.all([
      resolveSessionMcpConfig({ cwd: this.workspace.workDir, homeDir: this.bootstrap.homeDir }),
      this.plugins.enabledMcpServers(),
    ]);
    const servers = { ...base?.servers, ...pluginServers };
    if (Object.keys(servers).length === 0) return;
    await manager.connectAll(servers);
  }

  // ── Subagent orchestration ─────────────────────────────────────────

  async runSubagent(opts: RunSubagentOptions): Promise<SubagentRunHandle> {
    const { callerAgentId, profileName, signal } = opts;
    const caller = this.handles.get(callerAgentId);
    if (caller === undefined) throw new Error(`Caller agent "${callerAgentId}" does not exist`);

    const profile = this.catalog.get(profileName);
    if (profile === undefined) throw new Error(`Unknown agent type: "${profileName}"`);

    const child = await this.spawn(callerAgentId);
    applyProfileToAgent(child, profile);

    const promptText = await this.withProfilePrefix(profile, opts.prompt);
    this.emitSubagentSpawned(caller, child.id, profileName, opts.metadata);
    this.telemetry?.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: opts.metadata?.runInBackground ?? false,
    });

    const observed = observeChildAgentTurn(
      caller,
      child,
      { kind: 'prompt', prompt: promptText },
      {
        profileName,
        summaryPolicy: profile.summaryPolicy,
        suppressRateLimitFailureEvent: opts.suppressRateLimitFailureEvent,
        signal,
        onReady: opts.onReady,
      },
    );
    if (observed === undefined) throw new Error('Subagent turn could not be started');

    return {
      agentId: child.id,
      profileName,
      completion: observed.completion.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  async resumeSubagent(opts: ResumeSubagentOptions): Promise<SubagentRunHandle> {
    const { callerAgentId, agentId, signal } = opts;
    const caller = this.handles.get(callerAgentId);
    if (caller === undefined) throw new Error(`Caller agent "${callerAgentId}" does not exist`);

    const child = this.handles.get(agentId);
    if (child === undefined) throw new Error(`Agent instance "${agentId}" does not exist`);

    const profileName =
      child.accessor.get(IAgentProfileService).data().profileName ?? 'subagent';
    const profile = this.catalog.get(profileName);

    this.emitSubagentSpawned(caller, agentId, profileName, opts.metadata);
    this.telemetry?.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: opts.metadata?.runInBackground ?? false,
    });

    const observed = observeChildAgentTurn(
      caller,
      child,
      { kind: 'prompt', prompt: opts.prompt },
      {
        profileName,
        summaryPolicy: profile?.summaryPolicy,
        signal,
      },
    );
    if (observed === undefined) throw new Error('Subagent turn could not be started');

    return {
      agentId,
      profileName,
      completion: observed.completion.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private emitSubagentSpawned(
    caller: IAgentScopeHandle,
    subagentId: string,
    profileName: string,
    metadata?: RunSubagentOptions['metadata'],
  ): void {
    caller.accessor.get(IAgentRecordService)?.signal({
      type: 'subagent.spawned',
      subagentId,
      subagentName: profileName,
      parentToolCallId: metadata?.parentToolCallId ?? '',
      callerAgentId: caller.id,
      description: metadata?.description,
      swarmIndex: metadata?.swarmIndex,
      runInBackground: metadata?.runInBackground ?? false,
    });
  }

  private async withProfilePrefix(
    profile: AgentProfileDefinition,
    prompt: string,
  ): Promise<string> {
    if (profile.promptPrefix === undefined) return prompt;
    try {
      const prefix = await profile.promptPrefix({
        cwd: this.workspace.workDir,
        runner: this.processRunner,
        log: this.log,
      });
      return prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt;
    } catch {
      return prompt;
    }
  }

  getHandle(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return Promise.resolve();
    this.handles.delete(agentId);
    handle.dispose();
    this.onDidDisposeEmitter.fire(agentId);
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agentLifecycle');
