import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionConfigService } from '#/config';
import { IContextService } from '#/context';
import { ContextService } from '#/context/contextService';
import { IInjectionService } from '#/injection';
import { InjectionService } from '#/injection/injectionService';
import { IKaosService } from '#/kaos';
import { IPlanService } from '#/plan';
import { PlanService } from '#/plan/planService';
import { IAgentRecords } from '#/records';
import { stubAgentRecords } from '../records/stubs';
import { ITurnService } from '#/turn';
import { stubTurn } from '../turn/stubs';

describe('PlanService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, stubAgentRecords());
    ix.stub(IKaosService, {});
    ix.stub(ISessionConfigService, {});
    ix.stub(ITurnService, stubTurn());
    ix.set(IContextService, new SyncDescriptor(ContextService));
    ix.set(IInjectionService, new SyncDescriptor(InjectionService));
    ix.set(IPlanService, new SyncDescriptor(PlanService));
  });
  afterEach(() => disposables.dispose());

  it('enter sets active and pushes a plan injection', async () => {
    const plan = ix.get(IPlanService);
    const injection = ix.get(IInjectionService);
    expect(plan.active).toBe(false);
    await plan.enter();
    expect(plan.active).toBe(true);
    expect(injection.flush()).toEqual([
      { kind: 'plan', content: 'Plan mode active — propose a plan before acting.' },
    ]);
    plan.cancel();
    expect(plan.active).toBe(false);
  });

  it('resets active on turn end', async () => {
    const plan = ix.get(IPlanService);
    const turn = ix.get(ITurnService);
    await plan.enter();
    await turn.prompt('go');
    expect(plan.active).toBe(false);
  });
});
