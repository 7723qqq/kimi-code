import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/agent-lifecycle/agentLifecycleService';
import { ISessionContext } from '#/session-context/sessionContext';
import { ISessionMetadata } from '#/session-metadata/sessionMetadata';

describe('AgentLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-agent-lifecycle-test',
      metaScope: 'test',
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({ id: 'sess_test', createdAt: 0, updatedAt: 0, archived: false }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent: () => Promise.resolve(),
    });
    ix.set(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService));
  });
  afterEach(() => disposables.dispose());

  it('create / getHandle / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.createMain();
    expect(main.id).toBe('main');
    expect(svc.getHandle('main')).toBe(main);
    expect(svc.list()).toEqual([main]);
    await svc.remove('main');
    expect(svc.getHandle('main')).toBeUndefined();
  });

  it('create assigns sequential ids when unspecified', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const a = await svc.create({});
    const b = await svc.create({});
    expect(a.id).not.toBe(b.id);
  });

  it('fires onDidCreate on create and onDidDispose on remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const created: string[] = [];
    const disposed: string[] = [];
    disposables.add(svc.onDidCreate((h) => created.push(h.id)));
    disposables.add(svc.onDidDispose((id) => disposed.push(id)));

    const a = await svc.create({});
    expect(created).toEqual([a.id]);

    await svc.remove(a.id);
    expect(disposed).toEqual([a.id]);
  });
});
