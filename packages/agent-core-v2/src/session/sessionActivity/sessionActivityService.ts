/**
 * `sessionActivity` domain (L6) — `ISessionActivity` implementation.
 *
 * Derives the session's lifecycle phase from the pending interactions held by
 * the `interaction` kernel (awaiting approval / question) and each agent's
 * active turn (`turn`, reached through `agentLifecycle` handles). Bound at
 * Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService } from '#/session/interaction';
import { IAgentTurnService } from '#/agent/turn';

import { ISessionActivity, type SessionStatus } from './sessionActivity';

export class SessionActivity implements ISessionActivity {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
  ) {}

  status(): SessionStatus {
    if (this.interaction.listPending('approval').length > 0) return 'awaiting_approval';
    if (this.interaction.listPending('question').length > 0) return 'awaiting_question';
    if (this.hasActiveTurn()) return 'running';
    if (this.hasAbortedTurn()) return 'aborted';
    return 'idle';
  }

  isIdle(): boolean {
    return this.status() === 'idle';
  }

  private hasActiveTurn(): boolean {
    for (const handle of this.agents.list()) {
      const turn = handle.accessor.get(IAgentTurnService);
      if (turn.getActiveTurn() !== undefined) return true;
    }
    return false;
  }

  private hasAbortedTurn(): boolean {
    for (const handle of this.agents.list()) {
      const reason = handle.accessor.get(IAgentTurnService).lastEndedReason();
      if (reason === 'cancelled' || reason === 'failed' || reason === 'filtered') {
        return true;
      }
    }
    return false;
  }
}

registerScopedService(LifecycleScope.Session, ISessionActivity, SessionActivity, InstantiationType.Delayed, 'sessionActivity');
