/**
 * `agent-lifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes. Bound at Session
 * scope. Removing an agent disposes its scope; surviving agents are disposed
 * with the session.
 */

import { join } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';
import { IPluginSessionStartInjectorService } from '#/contextInjector';
import { ILogService } from '#/log';
import { AgentMcpService, IAgentMcpService } from '#/mcp';
import { McpConnectionManager } from '#/mcp/connection-manager';
import { resolveSessionMcpConfig } from '#/mcp/session-config';
import { IPluginService } from '#/plugin';
import { ISessionContext } from '#/session-context';
import { ISessionMetadata } from '#/session-metadata';
import { ISessionWorkspaceContext } from '#/workspaceContext';
import { IAgentWireRecordService, AgentWireRecordService } from '#/wireRecord';

import { type CreateAgentOptions, IAgentLifecycleService } from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IScopeHandle>());
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
  ) {
    super();
  }

  async create(opts: CreateAgentOptions): Promise<IScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
    // Per-agent homedir → the wire-record persistence key (`hashKey(homedir)`).
    // Co-located under the session dir, mirroring v1's `<sessionDir>/agents/<id>`.
    const agentHomedir = join(this.ctx.sessionDir, 'agents', agentId);
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        extra: [
          [IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService, [{ homedir: agentHomedir }])],
          [IAgentMcpService, new SyncDescriptor(AgentMcpService, [{ manager: this.getMcpManager() }])],
        ],
      },
    );
    this.handles.set(agentId, handle);
    // Record the agent in the session registry so a closed-session fork can
    // enumerate every agent and relocate its wire log.
    await this.sessionMetadata.registerAgent(agentId, {
      homedir: agentHomedir,
      type: opts.type ?? (opts.parentAgentId === undefined ? 'main' : 'sub'),
      parentAgentId: opts.parentAgentId,
      swarmItem: opts.swarmItem,
    });
    this.onDidCreateEmitter.fire(handle);
    // Force-instantiate the agent's MCP service so it attaches the (shared)
    // manager's tools and registers the `wait-for-initial-load` hook before the
    // first turn — otherwise plugin/session MCP servers would connect but their
    // tools would never register until something explicitly requests the service.
    handle.accessor.get(IAgentMcpService);
    return handle;
  }

  async createMain(): Promise<IScopeHandle> {
    const handle = await this.create({ agentId: 'main' });
    // Force-instantiate the plugin session-start injector so it registers its
    // turn-cadence injection before the first turn. Main-agent only, matching
    // v1's `pluginSessionStarts: type === 'main' ? ... : undefined`.
    handle.accessor.get(IPluginSessionStartInjectorService);
    return handle;
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

  getHandle(agentId: string): IScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(): readonly IScopeHandle[] {
    return [...this.handles.values()];
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

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agent-lifecycle');
