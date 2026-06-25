import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IRestGateway, IScopeRegistry } from '#/gateway/gateway';
import { RestGateway, ScopeRegistry } from '#/gateway/gatewayService';
import { stubTurn } from '../turn/stubs';

describe('ScopeRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IScopeRegistry, new SyncDescriptor(ScopeRegistry));
  });
  afterEach(() => disposables.dispose());

  it('createSession / get / close', async () => {
    const reg = ix.get(IScopeRegistry);
    const h = await reg.createSession({ sessionId: 's1', workDir: '/tmp' });
    expect(h.id).toBe('s1');
    expect(reg.get('s1')).toBe(h);
    await reg.close('s1');
    expect(reg.get('s1')).toBeUndefined();
  });
});

describe('RestGateway', () => {
  it('routes prompt to the agent turn service', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());

    const turn = stubTurn();
    const agentHandle: IScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: () => turn } as unknown as ServicesAccessor,
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      create: () => Promise.resolve(agentHandle),
      createMain: () => Promise.resolve(agentHandle),
      getHandle: () => agentHandle,
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
    };
    const sessionHandle: IScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: { get: () => agents } as unknown as ServicesAccessor,
    };
    ix.stub(IScopeRegistry, {
      _serviceBrand: undefined,
      createSession: () => Promise.resolve(sessionHandle),
      get: (id) => (id === 's1' ? sessionHandle : undefined),
      close: () => Promise.resolve(),
    });
    ix.set(IRestGateway, new SyncDescriptor(RestGateway));

    const gw = ix.get(IRestGateway);
    await gw.prompt('s1', 'main', 'hello');
    expect(turn.prompts).toEqual(['hello']);

    disposables.dispose();
  });
});
