/**
 * `session` domain (L6) — `ISessionService` implementation.
 *
 * Owns the session's child-agent set and session-level operations; reads its
 * identity through `session-context`, drives agent lifecycle through
 * `agent-lifecycle`, broadcasts through `event`, persists session metadata
 * through `sessionMetaStore`, and records activity through `session-activity`.
 * Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { NotImplementedError } from '#/errors';
import { IEventService } from '#/event';
import { ISessionContext } from '#/session-context';
import { ISessionMetaStore } from '#/sessionMetaStore';
import { ISessionActivity } from '#/session-activity/sessionActivity';

import { type SessionStatus, ISessionService } from './session';

export class SessionService implements ISessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetaStore private readonly meta: ISessionMetaStore,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionActivity private readonly activity: ISessionActivity,
    @IEventService private readonly event: IEventService,
  ) {}

  status(): SessionStatus {
    return this.activity.status();
  }

  agents(): readonly IScopeHandle[] {
    return this.agentLifecycle.list();
  }

  fork(): Promise<IScopeHandle> {
    throw new NotImplementedError('SessionService.fork');
  }
  listChildren(): readonly IScopeHandle[] {
    return [];
  }
  compact(): Promise<void> {
    throw new NotImplementedError('SessionService.compact');
  }
  undo(): Promise<void> {
    throw new NotImplementedError('SessionService.undo');
  }
  async archive(): Promise<void> {
    await this.meta.write({ archived: true });
    for (const handle of this.agentLifecycle.list()) {
      await this.agentLifecycle.remove(handle.id);
    }
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId: this.ctx.sessionId },
    });
  }
}

registerScopedService(LifecycleScope.Session, ISessionService, SessionService, InstantiationType.Delayed, 'session');
