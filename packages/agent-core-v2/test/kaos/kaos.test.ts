import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEnvironmentService } from '#/environment/environment';
import { ILogService } from '#/log/log';
import { stubLog } from '../log/stubs';

import { IAgentKaos, IKaosFactory, ISessionKaosService } from '#/kaos/kaos';
import { AgentKaos } from '#/kaos/agentKaos';
import { KaosFactory } from '#/kaos/kaosFactory';
import { SessionKaosService } from '#/kaos/sessionKaosService';

describe('KaosFactory', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IEnvironmentService, {});
    ix.stub(ILogService, stubLog());
    ix.set(IKaosFactory, new SyncDescriptor(KaosFactory));
  });
  afterEach(() => disposables.dispose());

  it('creates a local kaos', async () => {
    const factory = ix.get(IKaosFactory);
    const kaos = await factory.create({ kind: 'local' });
    expect(typeof kaos.getcwd()).toBe('string');
  });

  it('pins to the requested cwd', async () => {
    const factory = ix.get(IKaosFactory);
    const base = await LocalKaos.create();
    const target = base.getcwd();
    const kaos = await factory.create({ kind: 'local', cwd: target });
    expect(kaos.getcwd()).toBe(target);
  });

  it('throws TODO for ssh', async () => {
    const factory = ix.get(IKaosFactory);
    await expect(factory.create({ kind: 'ssh', host: 'h' })).rejects.toThrow(/TODO/);
  });
});

describe('SessionKaosService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.set(ISessionKaosService, new SyncDescriptor(SessionKaosService));
  });
  afterEach(() => disposables.dispose());

  async function make(): Promise<{ svc: ISessionKaosService; kaos: LocalKaos }> {
    const svc = ix.get(ISessionKaosService);
    const kaos = await LocalKaos.create();
    svc.setToolKaos(kaos);
    return { svc, kaos };
  }

  it('throws before setToolKaos', () => {
    const svc = ix.get(ISessionKaosService);
    expect(() => svc.toolKaos).toThrow(/before setToolKaos/);
  });

  it('persistenceKaos defaults to toolKaos', async () => {
    const { svc, kaos } = await make();
    expect(svc.persistenceKaos).toBe(kaos);
  });

  it('setPersistenceKaos overrides the default', async () => {
    const { svc } = await make();
    const other = await LocalKaos.create();
    svc.setPersistenceKaos(other);
    expect(svc.persistenceKaos).toBe(other);
  });

  it('additionalDirs add / dedupe / remove', async () => {
    const { svc } = await make();
    svc.addAdditionalDir('/a');
    svc.addAdditionalDir('/b');
    svc.addAdditionalDir('/a');
    expect(svc.additionalDirs).toEqual(['/a', '/b']);
    svc.removeAdditionalDir('/a');
    expect(svc.additionalDirs).toEqual(['/b']);
  });

  it('systemContextKaos is pinned to the tool cwd', async () => {
    const { svc } = await make();
    const sys = svc.systemContextKaos;
    expect(sys.getcwd()).toBe(svc.toolKaos.getcwd());
    expect(sys).not.toBe(svc.toolKaos);
  });
});

describe('AgentKaos', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.set(ISessionKaosService, new SyncDescriptor(SessionKaosService));
    ix.set(IAgentKaos, new SyncDescriptor(AgentKaos));
  });
  afterEach(() => disposables.dispose());

  it('derives cwd from the session kaos and isolates chdir', async () => {
    const session = ix.get(ISessionKaosService);
    const base = await LocalKaos.create();
    session.setToolKaos(base);

    const agent = ix.get(IAgentKaos);
    expect(agent.cwd).toBe(base.getcwd());

    const next = base.withCwd('/').getcwd();
    await agent.chdir('/');
    expect(agent.cwd).toBe(next);
    expect(session.toolKaos.getcwd()).toBe(base.getcwd());
  });
});
