/**
 * `agent-lifecycle` domain (L6) — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes. Bound at Session
 * scope. Removing an agent disposes its scope; surviving agents are disposed
 * with the session.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';

import { type CreateAgentOptions, IAgentLifecycleService } from './agentLifecycle';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IScopeHandle>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
    super();
  }

  create(opts: CreateAgentOptions): Promise<IScopeHandle> {
    const agentId = opts.agentId ?? `agent-${nextAgentId++}`;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
    );
    this.handles.set(agentId, handle);
    return Promise.resolve(handle);
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
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Session, IAgentLifecycleService, AgentLifecycleService, InstantiationType.Delayed, 'agent-lifecycle');
