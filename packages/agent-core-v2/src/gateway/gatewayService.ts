/**
 * `gateway` domain (L7) — `IScopeRegistry` / `IRestGateway` / `IWSGateway` /
 * `IWSBroadcastService` implementation.
 *
 * Owns the session scope registry and the REST/WS entry points; resolves agents
 * through `agent-lifecycle`, drives turns through `turn`, flushes logs through
 * `log`, and subscribes to broadcasts through `event`. Bound at Core scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event';
import { ILogService, ISessionLogService } from '#/log';
import { IPromptService } from '#/prompt';
import { ITurnService } from '#/turn';

import {
  type CreateSessionOptions,
  IRestGateway,
  IScopeRegistry,
  IWSBroadcastService,
  IWSGateway,
} from './gateway';

export class ScopeRegistry implements IScopeRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, IScopeHandle>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  createSession(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
    );
    this.sessions.set(opts.sessionId, handle);
    return Promise.resolve(handle);
  }

  get(sessionId: string): IScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IScopeRegistry private readonly scopes: IScopeRegistry,
    @ILogService private readonly log: ILogService,
  ) {}

  private agent(sessionId: string, agentId: string): IScopeHandle {
    const session = this.scopes.get(sessionId);
    if (session === undefined) throw new Error(`unknown session '${sessionId}'`);
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.getHandle(agentId);
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`);
    return agent;
  }

  prompt(sessionId: string, agentId: string, input: string): Promise<void> {
    this.agent(sessionId, agentId).accessor.get(IPromptService).prompt({
      role: 'user',
      content: [{ type: 'text', text: input }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    return Promise.resolve();
  }
  steer(sessionId: string, agentId: string, content: string): Promise<void> {
    this.agent(sessionId, agentId).accessor.get(IPromptService).steer({
      role: 'user',
      content: [{ type: 'text', text: content }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    return Promise.resolve();
  }
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void> {
    this.agent(sessionId, agentId).accessor.get(ITurnService).cancel(undefined, reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.scopes.get(sessionId) !== undefined);
  }

  async flushLogs(sessionId: string): Promise<void> {
    const session = this.scopes.get(sessionId);
    if (session === undefined) return;
    await session.accessor.get(ISessionLogService).flush();
  }

  flushGlobalLogs(): Promise<void> {
    return this.log.flush();
  }
}

export class WSGateway implements IWSGateway {
  declare readonly _serviceBrand: undefined;
  private readonly connections = new Set<string>();

  constructor(
    @IScopeRegistry _scopes: IScopeRegistry,
    @IEventService _event: IEventService,
  ) {}

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IEventService event: IEventService) {
    super();
    event.subscribe(() => {
    });
  }
}

registerScopedService(LifecycleScope.Core, IScopeRegistry, ScopeRegistry, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IRestGateway, RestGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IWSGateway, WSGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.Core, IWSBroadcastService, WSBroadcastService, InstantiationType.Delayed, 'gateway');
