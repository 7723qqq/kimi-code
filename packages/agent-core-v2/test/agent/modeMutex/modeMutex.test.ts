import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

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
import { IAgentHelloWorldService } from '#/features/helloWorld/agent/helloWorld';
import { HelloWorldModeEnter } from '#/features/helloWorld/helloWorldOps';
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
  let planEnter: ReturnType<typeof mock>;
  let planExit: ReturnType<typeof mock>;
  let specEnter: ReturnType<typeof mock>;
  let specExit: ReturnType<typeof mock>;
  let swarmEnter: ReturnType<typeof mock>;
  let swarmExit: ReturnType<typeof mock>;
  let helloWorldEnter: ReturnType<typeof mock>;
  let helloWorldExit: ReturnType<typeof mock>;
  let towerEnter: ReturnType<typeof mock>;
  let towerExit: ReturnType<typeof mock>;
  let goalPause: ReturnType<typeof mock>;
  let dispatch: ReturnType<typeof mock>;
  let swarmActive: boolean;
  let helloWorldActive: boolean;
  let towerActive: boolean;
  let goalStatus: string | undefined;
  let state: IAgentStateService;
  let mutex: IAgentModeMutexService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentStateService, new AgentStateService());
    registerTestAgentWire(ix, testWireScope('wire', 'mode-mutex-test'), {
      eventBus: ix.get(IEventBus),
    });
    state = ix.get(IAgentStateService);
    state.contributeState(planKey);
    state.contributeState(specKey);
    swarmActive = false;
    helloWorldActive = false;
    towerActive = false;
    goalStatus = undefined;
    goalPause = mock();
    dispatch = mock();

    planEnter = mock(async () => {
      state.set(planKey, { active: true, id: 'plan_1' });
    });
    planExit = mock(() => {
      state.set(planKey, { active: false });
    });
    specEnter = mock(async () => {
      state.set(specKey, { active: true, id: 'spec_1' });
    });
    specExit = mock(() => {
      state.set(specKey, { active: false });
    });
    swarmEnter = mock(() => {
      swarmActive = true;
    });
    swarmExit = mock(() => {
      swarmActive = false;
    });
    helloWorldEnter = mock(() => {
      helloWorldActive = true;
    });
    helloWorldExit = mock(() => {
      helloWorldActive = false;
    });
    towerEnter = mock(async () => {
      towerActive = true;
      return { entered: true } as const;
    });
    towerExit = mock(async () => {
      towerActive = false;
    });

    ix.stub(IAgentPlanService, {
      enter: planEnter,
      exit: planExit,
    } as unknown as IAgentPlanService);
    ix.stub(IAgentSpecService, {
      enter: specEnter,
      exit: specExit,
    } as unknown as IAgentSpecService);
    ix.stub(IAgentSwarmService, {
      enter: swarmEnter,
      exit: swarmExit,
      get isActive() {
        return swarmActive;
      },
    } as unknown as IAgentSwarmService);
    ix.stub(IAgentHelloWorldService, {
      enter: helloWorldEnter,
      exit: helloWorldExit,
      get isActive() {
        return helloWorldActive;
      },
    } as unknown as IAgentHelloWorldService);
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

    ix.set(IAgentModeMutexService, new SyncDescriptor(AgentModeMutexService));
    mutex = ix.get(IAgentModeMutexService);
  });
  afterEach(() => disposables.dispose());

  function publish(
    event: PlanModeEnter | SwarmModeEnter | HelloWorldModeEnter | TowerModeEnter | GoalUpdated,
  ): void {
    const agentContext = ix.get(IAgentScopeContext).agentContext;
    ix.get(IEventBus).publish(event, agentContext);
  }

  describe('event subscriptions (existing behaviour)', () => {
    it('plan mode entry exits an active tower mode', () => {
      towerActive = true;
      publish(new PlanModeEnter({ agentId: 'test-agent', id: 'plan_1' }));
      expect(towerExit).toHaveBeenCalledTimes(1);
      expect(towerExit).toHaveBeenCalledWith('mode-mutex');
    });

    it('plan mode entry leaves an inactive tower mode alone', () => {
      publish(new PlanModeEnter({ agentId: 'test-agent', id: 'plan_1' }));
      expect(towerExit).not.toHaveBeenCalled();
    });

    it('swarm mode entry exits an active tower mode', () => {
      towerActive = true;
      publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).toHaveBeenCalledTimes(1);
      expect(towerExit).toHaveBeenCalledWith('mode-mutex');
    });

    it('swarm mode entry leaves an inactive tower mode alone', () => {
      publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).not.toHaveBeenCalled();
    });

    it('hello-world mode entry exits an active tower mode', () => {
      towerActive = true;
      publish(new HelloWorldModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).toHaveBeenCalledTimes(1);
      expect(towerExit).toHaveBeenCalledWith('mode-mutex');
    });

    it('hello-world mode entry leaves an inactive tower mode alone', () => {
      publish(new HelloWorldModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).not.toHaveBeenCalled();
    });

    it('swarm mode entry exits an active hello-world mode', () => {
      helloWorldActive = true;
      publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(helloWorldExit).toHaveBeenCalledTimes(1);
    });

    it('hello-world mode entry exits an active swarm mode', () => {
      swarmActive = true;
      publish(new HelloWorldModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(swarmExit).toHaveBeenCalledTimes(1);
    });

    it('tower mode entry exits an active plan mode, swarm mode and hello-world mode', () => {
      state.set(planKey, { active: true, id: 'plan_1' });
      swarmActive = true;
      helloWorldActive = true;
      publish(new TowerModeEnter({ agentId: 'test-agent' }));
      expect(planExit).toHaveBeenCalledTimes(1);
      expect(swarmExit).toHaveBeenCalledTimes(1);
      expect(helloWorldExit).toHaveBeenCalledTimes(1);
    });

    it('tower mode entry leaves inactive plan, swarm and hello-world modes alone', () => {
      publish(new TowerModeEnter({ agentId: 'test-agent' }));
      expect(planExit).not.toHaveBeenCalled();
      expect(swarmExit).not.toHaveBeenCalled();
      expect(helloWorldExit).not.toHaveBeenCalled();
    });
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

  describe('switchTo', () => {
    it('evicts an active plan mode when entering spec', async () => {
      await mutex.switchTo('plan');
      await mutex.switchTo('spec');
      expect(state.get(planKey).active).toBe(false);
      expect(state.get(specKey).active).toBe(true);
    });

    it('evicts an active spec mode when entering plan', async () => {
      await mutex.switchTo('spec');
      await mutex.switchTo('plan');
      expect(state.get(specKey).active).toBe(false);
      expect(state.get(planKey).active).toBe(true);
    });

    it('is a no-op when the target mode is already active', async () => {
      await mutex.switchTo('spec');
      await expect(mutex.switchTo('spec')).resolves.toBeUndefined();
      expect(specEnter).toHaveBeenCalledTimes(1);
    });

    it('leaves plan and swarm both active — the allowed pair', async () => {
      await mutex.switchTo('plan');
      await mutex.switchTo('swarm');
      expect(state.get(planKey).active).toBe(true);
      expect(swarmActive).toBe(true);
    });

    it('evicts spec when entering tower', async () => {
      await mutex.switchTo('spec');
      await mutex.switchTo('tower');
      expect(state.get(specKey).active).toBe(false);
      expect(towerActive).toBe(true);
    });

    it('evicts tower when entering spec', async () => {
      await mutex.switchTo('tower');
      await mutex.switchTo('spec');
      expect(towerActive).toBe(false);
      expect(state.get(specKey).active).toBe(true);
    });

    it('evicts spec when entering swarm', async () => {
      await mutex.switchTo('spec');
      await mutex.switchTo('swarm');
      expect(state.get(specKey).active).toBe(false);
      expect(swarmActive).toBe(true);
    });

    it('evicts swarm when entering spec', async () => {
      await mutex.switchTo('swarm');
      await mutex.switchTo('spec');
      expect(swarmActive).toBe(false);
      expect(state.get(specKey).active).toBe(true);
    });

    it('leaves plan and hello-world both active — the allowed pair', async () => {
      await mutex.switchTo('plan');
      await mutex.switchTo('hello-world');
      expect(state.get(planKey).active).toBe(true);
      expect(helloWorldActive).toBe(true);
    });

    it('evicts spec when entering hello-world', async () => {
      await mutex.switchTo('spec');
      await mutex.switchTo('hello-world');
      expect(state.get(specKey).active).toBe(false);
      expect(helloWorldActive).toBe(true);
    });

    it('evicts hello-world when entering spec', async () => {
      await mutex.switchTo('hello-world');
      await mutex.switchTo('spec');
      expect(helloWorldActive).toBe(false);
      expect(state.get(specKey).active).toBe(true);
    });

    it('evicts swarm when entering hello-world', async () => {
      await mutex.switchTo('swarm');
      await mutex.switchTo('hello-world');
      expect(swarmActive).toBe(false);
      expect(helloWorldActive).toBe(true);
    });

    it('evicts hello-world when entering swarm', async () => {
      await mutex.switchTo('hello-world');
      await mutex.switchTo('swarm');
      expect(helloWorldActive).toBe(false);
      expect(swarmActive).toBe(true);
    });

    it('evicts tower when entering hello-world', async () => {
      await mutex.switchTo('tower');
      await mutex.switchTo('hello-world');
      expect(towerActive).toBe(false);
      expect(helloWorldActive).toBe(true);
    });

    it('evicts hello-world when entering tower', async () => {
      await mutex.switchTo('hello-world');
      await mutex.switchTo('tower');
      expect(helloWorldActive).toBe(false);
      expect(towerActive).toBe(true);
    });
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
