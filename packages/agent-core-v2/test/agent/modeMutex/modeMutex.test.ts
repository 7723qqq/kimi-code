import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentModeMutexService } from '#/agent/modeMutex/modeMutex';
import { AgentModeMutexService } from '#/agent/modeMutex/modeMutexService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { GoalUpdated } from '#/features/goal/goalOps';
import { IAgentGoalService } from '#/features/goal/goalService';
import type { GoalSnapshot } from '#/features/goal/types';
import { IAgentPlanService } from '#/features/plan/plan';
import { PlanModeEnter, planKey } from '#/features/plan/planOps';
import { IAgentSpecService } from '#/features/spec/spec';
import { specKey } from '#/features/spec/specOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { SwarmModeEnter } from '#/features/swarm/swarmOps';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerModeEnter } from '#/features/tower/towerOps';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { registerTestAgentWire, testWireScope } from '../../wire/stubs';

describe('AgentModeMutexService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let planEnter: ReturnType<typeof vi.fn>;
  let planExit: ReturnType<typeof vi.fn>;
  let specEnter: ReturnType<typeof vi.fn>;
  let specExit: ReturnType<typeof vi.fn>;
  let swarmEnter: ReturnType<typeof vi.fn>;
  let swarmExit: ReturnType<typeof vi.fn>;
  let towerEnter: ReturnType<typeof vi.fn>;
  let towerExit: ReturnType<typeof vi.fn>;
  let goalPause: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;
  let swarmActive: boolean;
  let towerActive: boolean;
  let goalStatus: string | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentStateService, new AgentStateService());
    registerTestAgentWire(ix, testWireScope('wire', 'mode-mutex-test'), {
      eventBus: ix.get(IEventBus),
    });
    planExit = vi.fn();
    swarmExit = vi.fn();
    towerExit = vi.fn();
    goalPause = vi.fn();
    dispatch = vi.fn();
    swarmActive = false;
    towerActive = false;
    goalStatus = undefined;
    ix.stub(IAgentPlanService, { exit: planExit } as unknown as IAgentPlanService);
    ix.stub(IAgentSwarmService, {
      enter: swarmEnter,
      exit: swarmExit,
      get isActive() {
        return swarmActive;
      },
    } as unknown as IAgentSwarmService);
    ix.stub(IAgentTowerService, {
      enter: towerEnter,
      exit: towerExit,
      get isActive() {
        return towerActive;
      },
    } as unknown as IAgentTowerService);
    ix.stub(IAgentGoalService, {
      pauseGoal: goalPause,
      getGoal: () => ({ goal: goalStatus === undefined ? null : { status: goalStatus } }),
    } as unknown as IAgentGoalService);
    ix.stub(IEventDispatcher, { dispatch } as unknown as IEventDispatcher);
    ix.get(IAgentStateService).contributeState(planKey);
    ix.set(IAgentModeMutexService, new SyncDescriptor(AgentModeMutexService));
    mutex = ix.get(IAgentModeMutexService);
  });
  afterEach(() => disposables.dispose());

  function publish(event: PlanModeEnter | SwarmModeEnter | TowerModeEnter | GoalUpdated): void {
    const agentContext = ix.get(IAgentScopeContext).agentContext;
    ix.get(IEventBus).publish(event, agentContext);
  }

  it('plan mode entry exits an active tower mode', () => {
    towerActive = true;
    publish(new PlanModeEnter({ agentId: 'test-agent', id: 'plan_1' }));
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
  });

  describe('activeMode', () => {
    it('reports null on a fresh agent', () => {
      expect(mutex.activeMode()).toBeNull();
    });

    it('reports the mode that switchTo entered', async () => {
      await mutex.switchTo('spec');
      expect(mutex.activeMode()).toBe('spec');
    });

    it('reports null after leave', async () => {
      await mutex.switchTo('plan');
      await mutex.leave('plan');
      expect(mutex.activeMode()).toBeNull();
    });
  });

  it('swarm mode entry exits an active tower mode', () => {
    towerActive = true;
    publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
  });

  describe('switchTo — failure semantics', () => {
    it('restores the previous mode when the target entry throws', async () => {
      await mutex.switchTo('plan');
      specEnter.mockRejectedValueOnce(new Error('spec directory is not writable'));

      await expect(mutex.switchTo('spec')).rejects.toThrow('spec directory is not writable');

      expect(state.get(planKey).active).toBe(true);
      expect(state.get(specKey).active).toBe(false);
    });

    it('propagates the original error even when the restore also fails', async () => {
      await mutex.switchTo('plan');
      specEnter.mockRejectedValueOnce(new Error('target failed'));
      planEnter.mockRejectedValueOnce(new Error('restore failed'));

      await expect(mutex.switchTo('spec')).rejects.toThrow('target failed');
    });

    it('does not evict anything when the target entry throws and nothing was active', async () => {
      specEnter.mockRejectedValueOnce(new Error('nope'));
      await expect(mutex.switchTo('spec')).rejects.toThrow('nope');
      expect(mutex.activeMode()).toBeNull();
    });
  });

  describe('event subscriptions cover spec', () => {
    it('tower mode entry exits an active spec mode', () => {
      state.set(specKey, { active: true, id: 'spec_1' });
      publish(new TowerModeEnter({ agentId: 'test-agent' }));
      expect(specExit).toHaveBeenCalledTimes(1);
    });
  });

  it('tower mode entry pauses an active goal', () => {
    goalStatus = 'active';
    publish(new TowerModeEnter({ agentId: 'test-agent' }));
    expect(goalPause).toHaveBeenCalledTimes(1);
  });

  it('tower mode entry leaves a non-active goal alone', () => {
    goalStatus = 'paused';
    publish(new TowerModeEnter({ agentId: 'test-agent' }));
    expect(goalPause).not.toHaveBeenCalled();
  });

  it('goal activation exits an active tower mode with the mode-mutex reason', () => {
    towerActive = true;
    publish(
      new GoalUpdated({
        agentId: 'test-agent',
        snapshot: { status: 'active' } as GoalSnapshot,
      }),
    );
    expect(towerExit).toHaveBeenCalledTimes(1);
    expect(towerExit).toHaveBeenCalledWith('mode-mutex');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const status = dispatch.mock.calls[0]![0] as AgentStatusUpdated;
    expect(status).toBeInstanceOf(AgentStatusUpdated);
    expect(status.agentId).toBe('test-agent');
    expect(status.towerMode).toBe(false);
    expect(status.towerExitReason).toBe('mode-mutex');
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      towerExit.mock.invocationCallOrder[0]!,
    );
  });

  it('goal activation leaves an inactive tower mode alone', () => {
    publish(
      new GoalUpdated({
        agentId: 'test-agent',
        snapshot: { status: 'active' } as GoalSnapshot,
      }),
    );
    expect(towerExit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a non-active goal update does not exit tower mode', () => {
    towerActive = true;
    publish(
      new GoalUpdated({
        agentId: 'test-agent',
        snapshot: { status: 'paused' } as GoalSnapshot,
      }),
    );
    expect(towerExit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
