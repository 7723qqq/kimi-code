import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IRestGateway, IScopeRegistry } from '#/gateway/gateway';
import { RestGateway, ScopeRegistry } from '#/gateway/gatewayService';
import { ILogService, ISessionLogService } from '#/log/log';
import { stubLog } from '../log/stubs';
import { stubTurn } from '../turn/stubs';

describe('ScopeRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IScopeRegistry, ScopeRegistry);
      },
    });
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
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IRestGateway, RestGateway);
        reg.defineInstance(ILogService, stubLog());
      },
    });

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

    const gw = ix.get(IRestGateway);
    await gw.prompt('s1', 'main', 'hello');
    expect(turn.prompts).toEqual(['hello']);

    disposables.dispose();
  });
});

describe('RestGateway.flushLogs', () => {
  function buildGateway(opts: {
    sessionLog?: { flush: () => Promise<void> };
    globalLog?: ILogService;
    sessionId?: string;
  }) {
    const disposables = new DisposableStore();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IRestGateway, RestGateway);
        reg.defineInstance(ILogService, opts.globalLog ?? stubLog());
      },
    });
    const sessionHandle: IScopeHandle = {
      id: opts.sessionId ?? 's1',
      kind: LifecycleScope.Session,
      accessor: {
        get: (id: unknown) => (id === ISessionLogService ? opts.sessionLog : undefined),
      } as unknown as ServicesAccessor,
    };
    ix.stub(IScopeRegistry, {
      _serviceBrand: undefined,
      createSession: () => Promise.resolve(sessionHandle),
      get: (id) => (id === (opts.sessionId ?? 's1') ? sessionHandle : undefined),
      close: () => Promise.resolve(),
    });
    return { gw: ix.get(IRestGateway), disposables };
  }

  it('flushes the session log service for a known session', async () => {
    let flushed = false;
    const { gw, disposables } = buildGateway({
      sessionLog: { flush: () => { flushed = true; return Promise.resolve(); } },
    });
    await gw.flushLogs('s1');
    expect(flushed).toBe(true);
    disposables.dispose();
  });

  it('is a no-op for an unknown session', async () => {
    let flushed = false;
    const { gw, disposables } = buildGateway({
      sessionLog: { flush: () => { flushed = true; return Promise.resolve(); } },
    });
    await expect(gw.flushLogs('nope')).resolves.toBeUndefined();
    expect(flushed).toBe(false);
    disposables.dispose();
  });

  it('flushGlobalLogs delegates to the Core ILogService', async () => {
    let flushed = false;
    const globalLog: ILogService = {
      ...stubLog(),
      flush: () => { flushed = true; return Promise.resolve(); },
    };
    const { gw, disposables } = buildGateway({ globalLog });
    await gw.flushGlobalLogs();
    expect(flushed).toBe(true);
    disposables.dispose();
  });
});
