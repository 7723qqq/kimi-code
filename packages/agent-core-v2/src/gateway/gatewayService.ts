/**
 * `gateway` domain (L7) — `IRestGateway` / `IWSGateway` / `IWSBroadcastService`
 * implementation.
 *
 * Owns the REST/WS entry points; resolves sessions through `session-lifecycle`,
 * agents through `agent-lifecycle`, drives turns through `turn`, flushes logs
 * through `log`, and subscribes to broadcasts through `event`. Bound at App
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IAgentEventSinkService } from '#/eventSink';
import { ILogService, ISessionLogService } from '#/log';
import { IAgentPromptService } from '#/prompt';
import { ISessionLifecycleService } from '#/session-lifecycle';
import { IAgentTurnService } from '#/turn';

import { IRestGateway, IWSBroadcastService, IWSGateway } from './gateway';

export class RestGateway implements IRestGateway {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly sessions: ISessionLifecycleService,
    @ILogService private readonly log: ILogService,
  ) {}

  private agent(sessionId: string, agentId: string): IScopeHandle {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown session '${sessionId}'`);
    const agents = session.accessor.get(IAgentLifecycleService);
    const agent = agents.getHandle(agentId);
    if (agent === undefined) throw new Error(`unknown agent '${agentId}'`);
    return agent;
  }

  prompt(
    sessionId: string,
    agentId: string,
    input: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const turn = this.agent(sessionId, agentId).accessor.get(IAgentPromptService).prompt({
      role: 'user',
      content: [{ type: 'text', text: input }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    return Promise.resolve(turn === undefined ? undefined : { turn_id: turn.id });
  }
  steer(
    sessionId: string,
    agentId: string,
    content: string,
  ): Promise<{ readonly turn_id: number } | undefined> {
    const agent = this.agent(sessionId, agentId);
    const turn = agent.accessor.get(IAgentPromptService).steer({
      role: 'user',
      content: [{ type: 'text', text: content }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    const id = turn?.id ?? agent.accessor.get(IAgentTurnService).getActiveTurn()?.id;
    return Promise.resolve(id === undefined ? undefined : { turn_id: id });
  }
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void> {
    const activeTurn = this.agent(sessionId, agentId).accessor.get(IAgentTurnService).getActiveTurn();
    activeTurn?.abortController.abort(reason);
    return Promise.resolve();
  }
  getStatus(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.sessions.get(sessionId) !== undefined);
  }

  async flushLogs(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
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
    @ISessionLifecycleService _sessions: ISessionLifecycleService,
    @IAgentEventSinkService _event: IAgentEventSinkService,
  ) {}

  connect(connectionId: string): void {
    this.connections.add(connectionId);
  }
  broadcast(_sessionId: string, _event: unknown): void {
  }
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentEventSinkService event: IAgentEventSinkService) {
    super();
    this._register(
      event.on(() => {
      }),
    );
  }
}

registerScopedService(LifecycleScope.App, IRestGateway, RestGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.App, IWSGateway, WSGateway, InstantiationType.Delayed, 'gateway');
registerScopedService(LifecycleScope.App, IWSBroadcastService, WSBroadcastService, InstantiationType.Delayed, 'gateway');
