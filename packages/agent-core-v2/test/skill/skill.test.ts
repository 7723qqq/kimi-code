import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { ISkillRegistry, ISkillService } from '#/skill/skill';
import { ITurnService } from '#/turn/turn';
import { stubTurn } from '../turn/stubs';

import { SkillRegistry, SkillService } from '#/skill/skillService';

describe('SkillRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(ILogService, {});
    ix.set(ISkillRegistry, new SyncDescriptor(SkillRegistry));
  });
  afterEach(() => disposables.dispose());

  it('register / get / list', async () => {
    const reg = ix.get(ISkillRegistry);
    reg.register({ name: 'commit', root: '/skills/commit' });
    expect(reg.get('commit')).toEqual({ name: 'commit', root: '/skills/commit' });
    expect(reg.list()).toHaveLength(1);
    await reg.loadRoots(['/skills']);
  });
});

describe('SkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(ILogService, {});
    ix.stub(IAgentRecords, {});
    ix.set(ISkillRegistry, new SyncDescriptor(SkillRegistry));
    ix.set(ISkillService, new SyncDescriptor(SkillService));
  });
  afterEach(() => disposables.dispose());

  it('activate prompts the turn for a known skill', async () => {
    const reg = ix.get(ISkillRegistry);
    reg.register({ name: 'commit', root: '/skills/commit' });
    const turn = stubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.get(ISkillService);
    await svc.activate('commit');
    expect(turn.prompts).toEqual(['Activate skill: commit']);
  });

  it('activate throws for unknown skill', async () => {
    const turn = stubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.get(ISkillService);
    await expect(svc.activate('missing')).rejects.toThrow(/unknown skill/);
  });
});
