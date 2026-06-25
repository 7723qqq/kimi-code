import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { ICronFireCoordinator, ICronService } from '#/cron/cron';
import { CronFireCoordinator, CronService } from '#/cron/cronService';
import { IEnvironmentService } from '#/environment/environment';
import { stubEnvironment } from '../environment/stubs';
import { ILogService } from '#/log/log';
import { stubLog } from '../log/stubs';
import { ISessionMetaStore } from '#/records/records';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { ISessionContext } from '#/session-context/sessionContext';
import { ITelemetryService } from '#/telemetry/telemetry';
import { stubTurn } from '../turn/stubs';

function activity(idle: boolean): ISessionActivity {
  return { _serviceBrand: undefined, isIdle: () => idle };
}

describe('CronService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionContext, {});
    ix.stub(ITelemetryService, {});
    ix.stub(ILogService, stubLog());
    ix.stub(IEnvironmentService, stubEnvironment());
    ix.stub(ISessionMetaStore, {});
    ix.set(ICronService, new SyncDescriptor(CronService));
  });
  afterEach(() => disposables.dispose());

  function setActivity(idle: boolean): void {
    ix.stub(ISessionActivity, activity(idle));
  }

  it('create / list / delete', async () => {
    setActivity(true);
    const svc = ix.get(ICronService);
    const id = await svc.create({ id: '', cron: '1000', prompt: 'hi', recurring: false });
    expect(svc.list()).toHaveLength(1);
    await svc.delete(id);
    expect(svc.list()).toEqual([]);
  });

  it('tick fires due tasks only when idle', async () => {
    setActivity(false);
    const svc = ix.get(ICronService);
    const fired: string[] = [];
    svc.onDidFire((e) => fired.push(e.content));
    await svc.create({ id: 'a', cron: '1000', prompt: 'fire-me', recurring: false });
    svc.tick(Date.now() + 500);
    expect(fired).toEqual([]);
    (svc as unknown as { activity: ISessionActivity }).activity = activity(true);
    svc.tick(Date.now() + 2000);
    expect(fired).toEqual(['fire-me']);
  });

  it('one-shot tasks are removed after firing', async () => {
    setActivity(true);
    const svc = ix.get(ICronService);
    await svc.create({ id: 'a', cron: '1000', prompt: 'x', recurring: false });
    svc.tick(Date.now() + 2000);
    expect(svc.list()).toEqual([]);
  });
});

describe('CronFireCoordinator', () => {
  it('steers the main agent on fire', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionContext, {});
    ix.stub(ITelemetryService, {});
    ix.stub(ILogService, stubLog());
    ix.stub(IEnvironmentService, stubEnvironment());
    ix.stub(ISessionMetaStore, {});
    ix.stub(ISessionActivity, activity(true));
    ix.set(ICronService, new SyncDescriptor(CronService));
    ix.set(ICronFireCoordinator, new SyncDescriptor(CronFireCoordinator));

    const turn = stubTurn();
    const handle: IScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: () => turn } as unknown as ServicesAccessor,
    };
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: (id) => (id === 'main' ? handle : undefined),
      list: () => [handle],
      remove: () => Promise.resolve(),
    });

    const cron = ix.get(ICronService);
    ix.get(ICronFireCoordinator);
    await cron.create({ id: 'a', cron: '1000', prompt: 'steer-me', recurring: false });
    cron.tick(Date.now() + 2000);
    expect(turn.steered).toEqual(['steer-me']);
    disposables.dispose();
  });
});
