import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { IPluginSessionStartInjectorService } from '#/agent/contextInjector';
import { ILogService } from '#/app/log';
import { IPluginService } from '#/app/plugin';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService, _clearToolContributionsForTests } from '#/agent/toolRegistry';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

const pluginServiceStub = {
  _serviceBrand: undefined,
  onDidReload: () => ({ dispose: () => {} }),
  listPlugins: async () => [],
  installPlugin: async () => ({ id: '' }) as never,
  setPluginEnabled: async () => {},
  setPluginMcpServerEnabled: async () => {},
  removePlugin: async () => {},
  reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
  getPluginInfo: async () => undefined,
  listPluginCommands: async () => [],
  checkUpdates: async () => [],
  pluginSkillRoots: async () => [],
  enabledSessionStarts: async () => [],
  enabledMcpServers: async () => ({}),
  enabledHooks: async () => [],
} as unknown as IPluginService;

describe('AgentLifecycleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registerAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The unit under test force-instantiates the builtin-tools registrar per
    // created agent; clear module-level tool contributions so no real tool
    // (with its own service dependencies) is constructed in this unit test.
    _clearToolContributionsForTests();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    registerAgent = vi.fn(() => Promise.resolve());
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'sess_test',
      workspaceId: 'ws_test',
      sessionDir: '/tmp/kimi-agentLifecycle-test',
      metaScope: 'test',
    });
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      read: () => Promise.resolve({ id: 'sess_test', createdAt: 0, updatedAt: 0, archived: false }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: () => Promise.resolve(),
      registerAgent: registerAgent as ISessionMetadata['registerAgent'],
    });
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/tmp/kimi-agentLifecycle-home',
      cwd: '/tmp/kimi-agentLifecycle-home',
      agentHomedir: (_ws: string, _session: string, agentId: string) =>
        `/tmp/kimi-agentLifecycle-test/agents/${agentId}`,
      agentScope: (_ws: string, _session: string, agentId: string) =>
        `test/agents/${agentId}`,
    } as unknown as IBootstrapService);
    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: '/tmp/kimi-agentLifecycle-work',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext);
    ix.stub(IPluginService, pluginServiceStub);
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: (() => undefined) as IConfigService['get'],
    } as unknown as IConfigService);
    ix.stub(ILogService, noopLog);
    ix.stub(IPluginSessionStartInjectorService, {
      _serviceBrand: undefined,
    });
    ix.stub(IAgentToolRegistryService, {
      _serviceBrand: undefined,
      register: () => ({ dispose: () => {} }),
      resolve: () => undefined,
      list: () => [],
    } as unknown as IAgentToolRegistryService);
    ix.stub(IAgentToolExecutorService, {
      _serviceBrand: undefined,
      hooks: {
        onWillExecuteTool: { register: () => ({ dispose: () => {} }) },
        onDidExecuteTool: { register: () => ({ dispose: () => {} }) },
      },
    } as unknown as IAgentToolExecutorService);
    ix.set(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService));
  });
  afterEach(() => disposables.dispose());

  it('create / getHandle / list / remove', async () => {
    const svc = ix.get(IAgentLifecycleService);
    const main = await svc.create({ agentId: 'main' });
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

  it('persists provenance and labels when creating an agent', async () => {
    const svc = ix.get(IAgentLifecycleService);

    const child = await svc.create({
      agentId: 'child',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });

    expect(child.id).toBe('child');
    expect(registerAgent).toHaveBeenCalledWith('child', {
      homedir: '/tmp/kimi-agentLifecycle-test/agents/child',
      forkedFrom: 'main',
      labels: { swarmItem: 'swarm-item-1' },
    });
  });

  it('fork throws when the source agent does not exist', async () => {
    const svc = ix.get(IAgentLifecycleService);
    await expect(svc.fork('missing')).rejects.toThrow('Source agent "missing" does not exist');
  });

  it('run throws when the agent does not exist', () => {
    const svc = ix.get(IAgentLifecycleService);
    expect(() =>
      svc.run('missing', { kind: 'prompt', prompt: 'hi' }, { signal: new AbortController().signal }),
    ).toThrow('Agent "missing" does not exist');
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
