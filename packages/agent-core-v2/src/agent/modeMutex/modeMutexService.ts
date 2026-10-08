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
    if (this.agentState.get(planKey).active) return 'plan';
    if (this.agentState.get(specKey).active) return 'spec';
    if (this.swarm.isActive) return 'swarm';
    if (this.tower.isActive) return 'tower';
    return null;
  }

  async switchTo(target: ExclusiveReviewMode): Promise<void> {
    const previous = this.activeMode();
    if (previous === target) return;

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
