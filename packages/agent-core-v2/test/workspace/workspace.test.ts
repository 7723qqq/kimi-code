import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IKaosFactory } from '#/kaos/kaos';
import { ILogService } from '#/log/log';
import { stubLog } from '../log/stubs';
import { IWorkspaceFsService, IWorkspaceRegistry } from '#/workspace/workspace';
import { WorkspaceFsService, WorkspaceRegistry } from '#/workspace/workspaceService';

describe('WorkspaceRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IKaosFactory, {});
    ix.stub(ILogService, stubLog());
    ix.set(IWorkspaceRegistry, new SyncDescriptor(WorkspaceRegistry));
  });
  afterEach(() => disposables.dispose());

  it('register / get / list', () => {
    const reg = ix.get(IWorkspaceRegistry);
    const ws = reg.register('/repo');
    expect(ws.root).toBe('/repo');
    expect(reg.get(ws.id)).toEqual(ws);
    expect(reg.list()).toEqual([ws]);
  });
});

describe('WorkspaceFsService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IKaosFactory, {});
    ix.stub(ILogService, stubLog());
    ix.set(IWorkspaceRegistry, new SyncDescriptor(WorkspaceRegistry));
    ix.set(IWorkspaceFsService, new SyncDescriptor(WorkspaceFsService));
  });
  afterEach(() => disposables.dispose());

  it('resolves a relative path against a registered workspace', () => {
    const reg = ix.get(IWorkspaceRegistry);
    const ws = reg.register('/repo');
    const fs = ix.createInstance(WorkspaceFsService, reg);
    expect(fs.resolve(ws.id, 'src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('throws for unknown workspace', () => {
    const fs = ix.get(IWorkspaceFsService);
    expect(() => fs.resolve('nope', 'x')).toThrow(/unknown workspace/);
  });
});
