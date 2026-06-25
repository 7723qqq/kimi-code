import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IGoalService } from '#/goal/goal';
import { IInjectionService } from '#/injection/injection';
import { IAgentRecords } from '#/records/records';
import { ITurnService } from '#/turn/turn';
import { stubTurn } from '../turn/stubs';

import { GoalService } from '#/goal/goalService';

describe('GoalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, {});
    ix.stub(ITurnService, stubTurn());
    ix.stub(IInjectionService, {});
    ix.set(IGoalService, new SyncDescriptor(GoalService));
  });
  afterEach(() => disposables.dispose());

  it('create / update / clear track current goal', () => {
    const goal = ix.get(IGoalService);
    expect(goal.current).toBeUndefined();
    goal.create('build it');
    expect(goal.current).toEqual({ objective: 'build it', status: 'active' });
    goal.update({ status: 'done' });
    expect(goal.current?.status).toBe('done');
    goal.clear();
    expect(goal.current).toBeUndefined();
  });
});
