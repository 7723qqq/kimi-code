import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IApprovalService } from '#/approval';
import { ApprovalService } from '#/approval/approvalService';
import { ISessionConfigService } from '#/config';
import { ILogService } from '#/log';
import { stubLog } from '../log/stubs';
import {
  IPermissionPolicyRegistry,
  IPermissionService,
} from '#/permission';
import {
  PermissionPolicyRegistry,
  PermissionService,
} from '#/permission/permissionService';
import { IAgentRecords } from '#/records';
import { stubAgentRecords } from '../records/stubs';

describe('PermissionPolicyRegistry', () => {
  it('returns the first non-undefined decision', () => {
    const reg = new PermissionPolicyRegistry();
    reg.register({ name: 'p1', evaluate: () => undefined });
    reg.register({ name: 'p2', evaluate: () => 'deny' });
    reg.register({ name: 'p3', evaluate: () => 'allow' });
    expect(reg.evaluate({ toolName: 'bash', args: {} })).toBe('deny');
  });

  it('defaults to allow when no policy matches', () => {
    const reg = new PermissionPolicyRegistry();
    expect(reg.evaluate({ toolName: 'bash', args: {} })).toBe('allow');
  });
});

describe('PermissionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionConfigService, {});
    ix.stub(IAgentRecords, stubAgentRecords());
    ix.stub(ILogService, stubLog());
    ix.set(IPermissionPolicyRegistry, new SyncDescriptor(PermissionPolicyRegistry));
    ix.set(IApprovalService, new SyncDescriptor(ApprovalService));
    ix.set(IPermissionService, new SyncDescriptor(PermissionService));
  });
  afterEach(() => disposables.dispose());

  // NOTE: PermissionService is built via createInstance (not get) because each
  // test needs a different permission `mode` — a static argument the container
  // cannot bake into a singleton. See di-testing.md "Exceptions".
  function make(mode: 'yolo' | 'manual' | 'auto' = 'auto') {
    return {
      svc: ix.createInstance(PermissionService, mode),
      reg: ix.get(IPermissionPolicyRegistry),
      approval: ix.get(IApprovalService),
    };
  }

  it('yolo always allows', async () => {
    const { svc, reg } = make('yolo');
    reg.register({ name: 'deny-all', evaluate: () => 'deny' });
    expect(await svc.beforeToolCall({ toolName: 'bash', args: {} })).toBe('allow');
  });

  it('auto returns registry decision', async () => {
    const { svc, reg } = make('auto');
    reg.register({ name: 'deny-bash', evaluate: (ctx) => (ctx.toolName === 'bash' ? 'deny' : undefined) });
    expect(await svc.beforeToolCall({ toolName: 'bash', args: {} })).toBe('deny');
    expect(await svc.beforeToolCall({ toolName: 'read', args: {} })).toBe('allow');
  });

  it('auto routes ask through approval', async () => {
    const { svc, reg, approval } = make('auto');
    reg.register({ name: 'ask-all', evaluate: () => 'ask' });
    const p = svc.beforeToolCall({ toolName: 'bash', args: {} });
    approval.decide('bash', 'allow');
    await expect(p).resolves.toBe('allow');
  });

  it('manual always requests approval', async () => {
    const { svc, approval } = make('manual');
    const p = svc.beforeToolCall({ toolName: 'bash', args: {} });
    approval.decide('bash', 'deny');
    await expect(p).resolves.toBe('deny');
  });
});
