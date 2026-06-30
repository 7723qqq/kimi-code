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
import { ISessionContext } from '#/session-context';
import { ISessionMetadata } from '#/session-metadata';
import { IAgentWireRecordService, AgentWireRecordService } from '#/wireRecord';

import { type CreateAgentOptions, IAgentLifecycleService } from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());

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
        extra: [[IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService, [{ homedir: agentHomedir }])]],
      },
    );
    this.handles.set(agentId, handle);
    // Record the agent in the session registry so a closed-session fork can
    // enumerate every agent and relocate its wire log.
    await this.sessionMetadata.registerAgent(agentId, { homedir: agentHomedir });
    this.onDidCreateEmitter.fire(handle);
    return handle;
  }

  createMain(): Promise<IScopeHandle> {
    return this.create({ agentId: 'main' });
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
