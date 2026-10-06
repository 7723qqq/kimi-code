import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentModeMutexService } from '#/agent/modeMutex/modeMutex';
import { AgentModeMutexService } from '#/agent/modeMutex/modeMutexService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentPlanService } from '#/features/plan/plan';
import { PlanModeEnter, planKey } from '#/features/plan/planOps';
import { IAgentSpecService } from '#/features/spec/spec';
import { specKey } from '#/features/spec/specOps';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { SwarmModeEnter } from '#/features/swarm/swarmOps';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerModeEnter } from '#/features/tower/towerOps';

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
  let state: IAgentStateService;

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

    planEnter = vi.fn(async () => {
      state.set(planKey, { active: true, id: 'plan_1' });
    });
    planExit = vi.fn(() => {
      state.set(planKey, { active: false });
    });
    specEnter = vi.fn(async () => {
      state.set(specKey, { active: true, id: 'spec_1' });
    });
    specExit = vi.fn(() => {
      state.set(specKey, { active: false });
    });
    swarmEnter = vi.fn(() => {
      swarmActive = true;
    });
    swarmExit = vi.fn(() => {
      swarmActive = false;
    });
    towerEnter = vi.fn(async () => {
      towerActive = true;
      return { entered: true } as const;
    });
    towerExit = vi.fn(async () => {
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
    ix.stub(IAgentTowerService, {
      enter: towerEnter,
      exit: towerExit,
      get isActive() {
        return towerActive;
      },
    } as unknown as IAgentTowerService);

    ix.set(IAgentModeMutexService, new SyncDescriptor(AgentModeMutexService));
    mutex = ix.get(IAgentModeMutexService);
  });
  afterEach(() => disposables.dispose());

  let mutex: IAgentModeMutexService;
  let swarmActive = false;
  let towerActive = false;

  function publish(event: PlanModeEnter | SwarmModeEnter | TowerModeEnter): void {
    const agentContext = ix.get(IAgentScopeContext).agentContext;
    ix.get(IEventBus).publish(event, agentContext);
  }

  describe('event subscriptions (existing behaviour)', () => {
    it('plan mode entry exits an active tower mode', () => {
      towerActive = true;
      publish(new PlanModeEnter({ agentId: 'test-agent', id: 'plan_1' }));
      expect(towerExit).toHaveBeenCalledTimes(1);
    });

    it('plan mode entry leaves an inactive tower mode alone', () => {
      publish(new PlanModeEnter({ agentId: 'test-agent', id: 'plan_1' }));
      expect(towerExit).not.toHaveBeenCalled();
    });

    it('swarm mode entry exits an active tower mode', () => {
      towerActive = true;
      publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).toHaveBeenCalledTimes(1);
    });

    it('swarm mode entry leaves an inactive tower mode alone', () => {
      publish(new SwarmModeEnter({ agentId: 'test-agent', trigger: 'manual' }));
      expect(towerExit).not.toHaveBeenCalled();
    });

    it('tower mode entry exits an active plan mode and an active swarm mode', () => {
      state.set(planKey, { active: true, id: 'plan_1' });
      swarmActive = true;
      publish(new TowerModeEnter({ agentId: 'test-agent' }));
      expect(planExit).toHaveBeenCalledTimes(1);
      expect(swarmExit).toHaveBeenCalledTimes(1);
    });

    it('tower mode entry leaves inactive plan and swarm modes alone', () => {
      publish(new TowerModeEnter({ agentId: 'test-agent' }));
      expect(planExit).not.toHaveBeenCalled();
      expect(swarmExit).not.toHaveBeenCalled();
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
});
