import { describe, expect, it, mock } from 'bun:test';

import type { Workspace, IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import { ErrorCodes } from '#/errors';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { RuntimeProviderFactory } from '#/runtime/runtimeProvider';
import type { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import type {
  RuntimeProviderHost,
  RuntimeProviderRuntimeHandle,
  RuntimeUnitHandle,
  RuntimeUnitHost,
  RuntimeUnitHostFactory,
} from '#/runtime/runtimeUnitHost';
import { WorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManagerService';

const imports = { root: [], imports: [], local: [] } as const;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workspace(id: string): Workspace {
  return { id, root: `/${id}`, name: id, createdAt: 0, lastOpenedAt: 0 };
}

function runtime(
  workspaceId: string,
  runtimeId: string,
  status: Runtime['status'] = 'connecting',
): FakeRuntime {
  return new FakeRuntime({ workspaceId, runtimeId, generation: `${runtimeId}-one` }, { status });
}

class TestRuntimeUnitHost implements RuntimeUnitHost {
  private readonly units: RuntimeUnitHandle[] = [];

  constructor(private readonly registry: RuntimeRegistry) {}

  async provide<T extends { dispose(): void | Promise<void> }>(
    _imports: typeof imports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<RuntimeUnitHandle> {
    const registrations: RuntimeProviderRuntimeHandle[] = [];
    const host: RuntimeProviderHost = {
      get: () => {
        throw new Error('no imports');
      },
      provide: () => {
        throw new Error('no local services');
      },
      registerRuntime: (value) => {
        const registration = this.registry.register(value);
        const handle: RuntimeProviderRuntimeHandle = {
          runtimeId: value.identity.runtimeId,
          update: async (next) => {
            await registration.replace(await next());
          },
          remove: () => registration.remove(),
        };
        registrations.push(handle);
        return handle;
      },
    };
    let attachment: T;
    try {
      attachment = await prepare(host);
    } catch (error) {
      for (const registration of registrations.toReversed()) await registration.remove();
      throw error;
    }
    let active = true;
    const dispose = async (): Promise<void> => {
      if (!active) return;
      active = false;
      await attachment.dispose();
      for (const registration of registrations.toReversed()) await registration.remove();
      const index = this.units.indexOf(handle);
      if (index >= 0) this.units.splice(index, 1);
    };
    const handle: RuntimeUnitHandle = {
      update: async () => {
        throw new Error('not supported');
      },
      remove: dispose,
      dispose,
    };
    this.units.push(handle);
    return handle;
  }

  async update(): Promise<void> {
    throw new Error('not supported');
  }

  remove(handle: RuntimeUnitHandle): Promise<void> {
    return handle.dispose();
  }

  async dispose(): Promise<void> {
    for (const unit of [...this.units].toReversed()) await unit.dispose();
  }
}

class TestRuntimeUnitHostFactory implements RuntimeUnitHostFactory {
  create(_root: never, registry: RuntimeRegistry): RuntimeUnitHost {
    return new TestRuntimeUnitHost(registry);
  }
}

function provider(
  id: string,
  runtimeId: string,
  events: string[],
  options: { failWorkspace?: string; status?: Runtime['status'] } = {},
): RuntimeProviderFactory {
  return {
    id,
    imports,
    attach: async (context, host) => {
      events.push(`attach:${id}:${context.id}`);
      if (options.failWorkspace === context.id) throw new Error(`attach failed ${context.id}`);
      host.registerRuntime(runtime(context.id, runtimeId, options.status));
      return {
        dispose: () => {
          events.push(`detach:${id}:${context.id}`);
        },
      };
    },
  };
}

function manager(
  values: readonly Workspace[],
  ready: Promise<void> = Promise.resolve(),
  events: string[] = [],
): WorkspaceInstanceManager {
  const byId = new Map(values.map((value) => [value.id, value]));
  const workspaces: IWorkspaceService = {
    _serviceBrand: undefined,
    list: async () => values,
    get: mock(async (id: string) => byId.get(id)),
    createOrTouch: mock(async (root: string) => {
      const value = values.find((entry) => entry.root === root);
      if (value === undefined) throw new Error(`unknown root ${root}`);
      return value;
    }),
    update: async () => undefined,
    delete: async () => {},
  };
  const args: unknown[] = [
    {},
    { scope: () => 'sessions' },
    workspaces,
    { ready },
    ...Array.from({ length: 25 }, () => undefined),
    new TestRuntimeUnitHostFactory(),
  ];
  args[18] = { entries: () => [] };
  const value = Reflect.construct(WorkspaceInstanceManager, args) as WorkspaceInstanceManager;
  const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> })
    .providers;
  providers.clear();
  providers.set('local', provider('local', 'local', events));
  return value;
}

describe('WorkspaceInstanceManager', () => {
  it('single-flights materialization while keeping leases independent and serializing replacement', async () => {
    const materialization = deferred();
    const closing = deferred();
    const events: string[] = [];
    const value = manager([workspace('one')], materialization.promise, events);
    const providers = (value as unknown as { providers: Map<string, RuntimeProviderFactory> })
      .providers;
    const local = provider('local', 'local', events);
    providers.set('local', {
      ...local,
      attach: async (context, host) => {
        const attachment = await local.attach(context, host);
        return {
          dispose: async () => {
            await closing.promise;
            await attachment.dispose();
          },
        };
      },
    });
    const firstPromise = value.acquire({ workspaceId: 'one' });
    const secondPromise = value.acquire({ root: '/one' });
    materialization.resolve();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).not.toBe(second);
    expect(first.instance).toBe(second.instance);
    first.dispose();
    expect(value.get('one')).toBe(first.instance);
    second.dispose();
    expect(value.get('one')).toBeUndefined();
    const replacementPromise = value.acquire({ workspaceId: 'one' });
    let replacementSettled = false;
    void replacementPromise.then(() => {
      replacementSettled = true;
    });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);
    closing.resolve();

    const replacement = await replacementPromise;
    expect(replacement.instance).not.toBe(first.instance);
    second.dispose();
    replacement.dispose();
    await value.dispose();
    expect(events).toEqual([
      'attach:local:one',
      'detach:local:one',
      'attach:local:one',
      'detach:local:one',
    ]);
  });

  it('keeps runtime registries and provider attachments isolated across workspaces', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const two = await value.acquire({ workspaceId: 'two' });

    expect(one.instance.runtimes.current('local')?.identity.workspaceId).toBe('one');
    expect(two.instance.runtimes.current('local')?.identity.workspaceId).toBe('two');
    expect(one.instance.runtimes.current('local')).not.toBe(two.instance.runtimes.current('local'));

    one.dispose();
    expect(value.get('two')).toBe(two.instance);
    expect(two.instance.runtimes.current('local')).toBeDefined();
    two.dispose();
    await value.dispose();
  });

  it('maintains both provider and workspace axes and detaches each matrix cell', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const remote = await value.addProvider(
      provider('remote-provider', 'remote', events, { status: 'ready' }),
    );
    const two = await value.acquire({ workspaceId: 'two' });

    expect(one.instance.runtimes.current('remote')).toBeDefined();
    expect(two.instance.runtimes.current('remote')).toBeDefined();

    await remote.dispose();
    expect(one.instance.runtimes.current('remote')).toBeUndefined();
    expect(two.instance.runtimes.current('remote')).toBeUndefined();
    expect(
      events.filter((event) => event.startsWith('detach:remote-provider:')).toSorted(),
    ).toEqual(['detach:remote-provider:one', 'detach:remote-provider:two']);
    one.dispose();
    two.dispose();
    await value.dispose();
  });

  it('rolls back earlier attachments when adding a provider fails on a later workspace', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const one = await value.acquire({ workspaceId: 'one' });
    const two = await value.acquire({ workspaceId: 'two' });

    await expect(
      value.addProvider(provider('broken', 'remote', events, { failWorkspace: 'two' })),
    ).rejects.toThrow('attach failed two');
    expect(one.instance.runtimes.current('remote')).toBeUndefined();
    expect(events).toContain('detach:broken:one');

    one.dispose();
    two.dispose();
    await value.dispose();
  });

  it('materializes once required local structure exists without waiting for ready status', async () => {
    const value = manager([workspace('one')]);
    const lease = await value.acquire({ workspaceId: 'one' });

    expect(lease.instance.runtimes.current('local')?.status).toBe('connecting');
    expect(lease.instance.program.status).toBe('preparing');
    expect(lease.instance.snapshot().lifecycle).toBe('active');
    lease.dispose();
    expect(value.get('one')).toBeUndefined();
    await value.dispose();
  });

  describe('findContaining', () => {
    function rootedWorkspace(id: string, root: string): Workspace {
      return { id, root, name: id, createdAt: 0, lastOpenedAt: 0 };
    }

    it('matches exact and nested cwds, preferring the longest containing root', async () => {
      const value = manager([
        rootedWorkspace('repo', '/repo'),
        rootedWorkspace('sub', '/repo/sub'),
      ]);
      const repo = await value.acquire({ workspaceId: 'repo' });
      const sub = await value.acquire({ workspaceId: 'sub' });

      expect(value.findContaining('/repo')?.id).toBe('repo');
      expect(value.findContaining('/repo/sub')?.id).toBe('sub');
      expect(value.findContaining('/repo/sub/deep/pkg')?.id).toBe('sub');
      expect(value.findContaining('/repo/other')?.id).toBe('repo');
      expect(value.findContaining('/repo-other')).toBeUndefined();
      expect(value.findContaining('/outside')).toBeUndefined();
      repo.dispose();
      sub.dispose();
      await value.dispose();
    });

    it('matches across Windows spelling variants', async () => {
      const value = manager([rootedWorkspace('win', 'C:\\Users\\Foo\\Repo')]);
      await value.acquire({ workspaceId: 'win' });

      expect(value.findContaining('c:/users/foo/repo')?.id).toBe('win');
      expect(value.findContaining('C:/Users/Foo/Repo/sub')?.id).toBe('win');
      expect(value.findContaining('D:/elsewhere')).toBeUndefined();
      await value.dispose();
    });

    it('matches any absolute cwd against a workspace rooted at /', async () => {
      const value = manager([rootedWorkspace('root', '/'), rootedWorkspace('repo', '/repo')]);
      const root = await value.acquire({ workspaceId: 'root' });
      const repo = await value.acquire({ workspaceId: 'repo' });

      expect(value.findContaining('/')?.id).toBe('root');
      expect(value.findContaining('/elsewhere')?.id).toBe('root');
      expect(value.findContaining('/repo/sub')?.id).toBe('repo');
      root.dispose();
      repo.dispose();
      await value.dispose();
    });
  });
});

describe('WorkspaceLifecycleService over the real manager', () => {
  function sessionManager(): ISessionManager {
    return {
      _serviceBrand: undefined,
      list: () => [],
      get: () => undefined,
      resume: async () => undefined,
      close: async () => undefined,
    } as unknown as ISessionManager;
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps one live lease across repeated and concurrent handlerFor calls, then releases the instance', async () => {
    const events: string[] = [];
    const value = manager([workspace('one')], Promise.resolve(), events);
    const lifecycle = new WorkspaceLifecycleService(value, sessionManager());
    try {
      const handler = await lifecycle.handlerFor({ workspaceId: 'one' });
      const more = await Promise.all([
        lifecycle.handlerFor({ workspaceId: 'one' }),
        lifecycle.handlerFor({ workspaceId: 'one' }),
        lifecycle.handlerFor({ workspaceId: 'one' }),
      ]);
      expect(more.every((entry) => entry === handler)).toBe(true);
      expect(lifecycle.handlers.list().map((entry) => entry.id)).toEqual(['one']);

      const references = (value as unknown as { references: Map<string, number> }).references;
      expect(references.get('one')).toBe(1);
      expect(value.get('one')).toBeDefined();

      handler.dispose();
      handler.dispose();
      await flush();

      expect(references.get('one')).toBeUndefined();
      expect(value.get('one')).toBeUndefined();
      expect(events).toEqual(['attach:local:one', 'detach:local:one']);
    } finally {
      lifecycle.dispose();
      await value.dispose();
    }
  });

  it('leaves no instance or lease behind when the workspace cannot be acquired', async () => {
    const events: string[] = [];
    const value = manager([], Promise.resolve(), events);
    const lifecycle = new WorkspaceLifecycleService(value, sessionManager());
    try {
      await expect(lifecycle.handlerFor({ workspaceId: 'missing' })).rejects.toMatchObject({
        code: ErrorCodes.WORKSPACE_NOT_FOUND,
      });

      const references = (value as unknown as { references: Map<string, number> }).references;
      expect(lifecycle.handlers.list()).toEqual([]);
      expect(value.list()).toEqual([]);
      expect(references.size).toBe(0);
      expect(events).toEqual([]);
    } finally {
      lifecycle.dispose();
      await value.dispose();
    }
  });

  it('follows the manager order and hands back the same handle per workspace', async () => {
    const events: string[] = [];
    const value = manager([workspace('one'), workspace('two')], Promise.resolve(), events);
    const lifecycle = new WorkspaceLifecycleService(value, sessionManager());
    try {
      const two = await lifecycle.handlerFor({ workspaceId: 'two' });
      const one = await lifecycle.handlerFor({ workspaceId: 'one' });

      expect(lifecycle.handlers.list().map((entry) => entry.id)).toEqual(
        value.list().map((instance) => instance.id),
      );
      expect(await lifecycle.handlerFor({ workspaceId: 'two' })).toBe(two);
      expect(await lifecycle.handlerFor({ workspaceId: 'one' })).toBe(one);

      one.dispose();
      two.dispose();
      await flush();

      expect(value.list()).toEqual([]);
      expect(events.toSorted()).toEqual([
        'attach:local:one',
        'attach:local:two',
        'detach:local:one',
        'detach:local:two',
      ]);
    } finally {
      lifecycle.dispose();
      await value.dispose();
    }
  });
});
