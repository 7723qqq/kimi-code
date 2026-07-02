/**
 * `session` domain (L6) — `ISessionService` implementation.
 *
 * Runs session-level commands; reads its identity through `sessionContext`,
 * mutates metadata through `sessionMetadata`, drives agent teardown through
 * `agentLifecycle`, and broadcasts through `event`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventService } from '#/app/event';
import { ISessionContext } from '#/session/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata';

import { ISessionService } from './session';

export class SessionService implements ISessionService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly meta: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly event: IEventService,
  ) {}

  async archive(): Promise<void> {
    await this.meta.setArchived(true);
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
