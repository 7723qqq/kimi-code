import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionLifecycleService } from '#/session-lifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/session-lifecycle/sessionLifecycleService';

describe('SessionLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionLifecycleService, new SyncDescriptor(SessionLifecycleService));
  });
  afterEach(() => disposables.dispose());

  it('create / get / list / close', async () => {
    const svc = ix.get(ISessionLifecycleService);
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp' });
    expect(h.id).toBe('s1');
    expect(svc.get('s1')).toBe(h);
    expect(svc.list()).toEqual([h]);
    await svc.close('s1');
    expect(svc.get('s1')).toBeUndefined();
  });
});
