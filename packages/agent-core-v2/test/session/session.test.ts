import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event';
import { ISessionContext } from '#/session-context';
import { ISessionMetaStore } from '#/sessionMetaStore';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { ISessionService } from '#/session';
import { SessionService } from '#/session/sessionService';

const handle: IScopeHandle = {
  id: 'main',
  kind: LifecycleScope.Agent,
  accessor: { get: () => ({}) } as unknown as ServicesAccessor,
};

describe('SessionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ISessionContext, { sessionId: 's1', meta: {} as ISessionMetaStore });
    ix.stub(ISessionMetaStore, {});
    ix.stub(IEventService, {});
    ix.set(ISessionService, new SyncDescriptor(SessionService));
  });
  afterEach(() => disposables.dispose());

  // NOTE: SessionService is built via createInstance (not get) because
  // "status reflects activity" needs two instances with different
  // ISessionActivity stubs within the same test — a singleton-per-container
  // cannot produce both. See di-testing.md "Exceptions".
  function make(idle: boolean): ISessionService {
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: () => handle,
      list: () => [handle],
      remove: () => Promise.resolve(),
    });
    ix.stub(ISessionActivity, {
      _serviceBrand: undefined,
      isIdle: () => idle,
      status: () => (idle ? 'idle' : 'running'),
    });
    return ix.createInstance(SessionService);
  }

  it('status reflects activity', () => {
    expect(make(true).status()).toBe('idle');
    expect(make(false).status()).toBe('running');
  });

  it('agents delegates to lifecycle', () => {
    expect(make(true).agents()).toEqual([handle]);
  });

  it('archive persists the flag, removes agents, and publishes the event', async () => {
    const writes: Record<string, unknown>[] = [];
    const removed: string[] = [];
    const published: { type: string; payload: unknown }[] = [];
    ix.stub(ISessionMetaStore, {
      write: (patch: Record<string, unknown>) => {
        writes.push(patch);
        return Promise.resolve();
      },
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: () => handle,
      list: () => [handle],
      remove: (id: string) => {
        removed.push(id);
        return Promise.resolve();
      },
    });
    ix.stub(ISessionActivity, { _serviceBrand: undefined, isIdle: () => true });
    ix.stub(IEventService, {
      publish: (event: { type: string; payload: unknown }) => published.push(event),
    });

    await ix.createInstance(SessionService).archive();

    expect(writes).toEqual([{ archived: true }]);
    expect(removed).toEqual(['main']);
    expect(published).toEqual([
      { type: 'event.session.archived', payload: { sessionId: 's1' } },
    ]);
  });
});
