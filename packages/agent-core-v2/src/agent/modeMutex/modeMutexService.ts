import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentPlanService } from '#/features/plan/plan';
import { PlanModeEnter, planKey } from '#/features/plan/planOps';
import { IAgentSpecService } from '#/features/spec/spec';
import { SpecModeEnter, specKey } from '#/features/spec/specOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { SwarmModeEnter } from '#/features/swarm/swarmOps';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerModeEnter } from '#/features/tower/towerOps';

import { IAgentModeMutexService, type ExclusiveReviewMode } from './modeMutex';

/**
 * Which modes each mode conflicts with. Entering a mode evicts everything it
 * conflicts with; the relation is intentionally asymmetric in one cell only —
 * `plan` does not evict `swarm`, and `swarm` does not evict `plan` — because a
 * plan-scoped swarm is a supported state that the footer advertises with its
 * combined badge.
 */
const CONFLICTS: Record<ExclusiveReviewMode, readonly ExclusiveReviewMode[]> = {
  plan: ['spec', 'tower'],
  spec: ['plan', 'swarm', 'tower'],
  swarm: ['spec', 'tower'],
  tower: ['plan', 'spec', 'swarm'],
};

export class AgentModeMutexService extends Disposable implements IAgentModeMutexService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentSpecService private readonly spec: IAgentSpecService,
    @IAgentSwarmService private readonly swarm: IAgentSwarmService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    // The subscriptions stay alongside `switchTo` because events can be
    // dispatched by code that never called the mutex — a resumed session
    // replaying its records, or a host integration dispatching directly.
    // `switchTo` is the path every entry point should use; these are the net.
    this._register(
      eventBus.subscribe(PlanModeEnter, () => {
        this.evictConflictsOf('plan');
      }),
    );
    this._register(
      eventBus.subscribe(SwarmModeEnter, () => {
        this.evictConflictsOf('swarm');
      }),
    );
    this._register(
      eventBus.subscribe(SpecModeEnter, () => {
        this.evictConflictsOf('spec');
      }),
    );
    this._register(
      eventBus.subscribe(TowerModeEnter, () => {
        this.evictConflictsOf('tower');
      }),
    );
  }

  activeMode(): ExclusiveReviewMode | null {
    // `plan` before `swarm`: with both active `plan` is the stricter guard, so
    // reporting it keeps `activeMode` consistent with what constrains the model.
    if (this.agentState.get(planKey).active) return 'plan';
    if (this.agentState.get(specKey).active) return 'spec';
    if (this.swarm.isActive) return 'swarm';
    if (this.tower.isActive) return 'tower';
    return null;
  }

  async switchTo(target: ExclusiveReviewMode): Promise<void> {
    const previous = this.activeMode();
    if (previous === target) return;

    // `plan` and `swarm` may coexist, so a switch to one of them must not evict
    // the other even though `previous` reads back as only one of the pair.
    if (previous !== null && !isAllowedPair(previous, target)) {
      await this.leave(previous);
    }

    try {
      await this.enter(target);
    } catch (error) {
      if (previous !== null) {
        try {
          await this.enter(previous);
        } catch {
          // The restore failed too. Propagate the original error: the caller
          // needs to know what it asked for failed, and the session is now in
          // no mode, which the caller can observe via activeMode().
        }
      }
      throw error;
    }
  }

  async leave(target: ExclusiveReviewMode): Promise<void> {
    switch (target) {
      case 'plan':
        if (this.agentState.get(planKey).active) this.plan.exit();
        return;
      case 'spec':
        if (this.agentState.get(specKey).active) this.spec.exit();
        return;
      case 'swarm':
        if (this.swarm.isActive) this.swarm.exit();
        return;
      case 'tower':
        if (this.tower.isActive) await this.tower.exit();
        return;
    }
  }

  private async enter(target: ExclusiveReviewMode): Promise<void> {
    switch (target) {
      case 'plan':
        if (!this.agentState.get(planKey).active) await this.plan.enter();
        return;
      case 'spec':
        if (!this.agentState.get(specKey).active) await this.spec.enter();
        return;
      case 'swarm':
        if (!this.swarm.isActive) this.swarm.enter('manual');
        return;
      case 'tower':
        if (!this.tower.isActive) await this.tower.enter();
        return;
    }
  }

  /**
   * Evict everything `entered` conflicts with. Runs synchronously for the modes
   * whose exit is synchronous (`plan`, `spec`, `swarm`); tower's exit is async
   * and is detached, matching how the entry paths already treat it.
   */
  private evictConflictsOf(entered: ExclusiveReviewMode): void {
    for (const conflicting of CONFLICTS[entered]) {
      switch (conflicting) {
        case 'plan':
          if (this.agentState.get(planKey).active) this.plan.exit();
          break;
        case 'spec':
          if (this.agentState.get(specKey).active) this.spec.exit();
          break;
        case 'swarm':
          if (this.swarm.isActive) this.swarm.exit();
          break;
        case 'tower':
          if (this.tower.isActive) void this.tower.exit();
          break;
      }
    }
  }
}

/** `plan` + `swarm` is the only pair a session may hold at once. */
function isAllowedPair(a: ExclusiveReviewMode, b: ExclusiveReviewMode): boolean {
  return (a === 'plan' && b === 'swarm') || (a === 'swarm' && b === 'plan');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentModeMutexService,
  AgentModeMutexService,
  ScopeActivation.OnScopeCreated,
  'modeMutex',
);
