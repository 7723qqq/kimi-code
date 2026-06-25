import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IBackgroundService } from '#/background/background';
import { IAgentKaos } from '#/kaos/kaos';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { ITelemetryService } from '#/telemetry/telemetry';

import { BackgroundService } from '#/background/backgroundService';

describe('BackgroundService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentKaos, {});
    ix.stub(IAgentRecords, {});
    ix.stub(ILogService, {});
    ix.stub(ITelemetryService, {});
    ix.stub(IAgentLifecycleService, {});
    ix.set(IBackgroundService, new SyncDescriptor(BackgroundService));
  });
  afterEach(() => disposables.dispose());

  it('start / list / stop / getOutput', async () => {
    const svc = ix.get(IBackgroundService);
    const id = await svc.start({ id: 'x', kind: 'process' });
    expect(svc.list()).toEqual([{ id: 'x', kind: 'process' }]);
    expect(await svc.getOutput(id)).toBe('');
    await svc.stop(id);
  });
});
