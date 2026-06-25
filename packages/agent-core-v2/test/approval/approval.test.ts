import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IApprovalService } from '#/approval/approval';
import { ApprovalService } from '#/approval/approvalService';

describe('ApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IApprovalService, new SyncDescriptor(ApprovalService));
  });
  afterEach(() => disposables.dispose());

  it('request parks until decide resolves it', async () => {
    const svc = ix.get(IApprovalService);
    const p = svc.request({ id: 'r1', toolName: 'bash' });
    expect(svc.listPending()).toEqual([{ id: 'r1', toolName: 'bash' }]);
    svc.decide('r1', 'allow');
    await expect(p).resolves.toBe('allow');
    expect(svc.listPending()).toEqual([]);
  });

  it('decide on unknown id is a no-op', () => {
    const svc = ix.get(IApprovalService);
    expect(() => svc.decide('missing', 'deny')).not.toThrow();
  });
});
