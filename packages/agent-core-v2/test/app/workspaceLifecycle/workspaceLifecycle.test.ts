import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  followWorkspaceHandlers,
  getLiveSessionById,
  resumeSessionById,
} from '#/app/sessionManager/sessionLookup';
import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import { Error2, ErrorCodes } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import {
  IWorkspaceInstanceManager,
  type WorkspaceInstanceRef,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';

interface FakeController {
  readonly id: string;
  resume: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onDidCloseSession: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function fakeInstance(id: string, root: string, controller: FakeController): WorkspaceInstance {
  return {
    id,
    root,
    program: {
      createSessionController: () => controller,
    },
  } as unknown as WorkspaceInstance;
}

function controllerStub(id: string): FakeController {
  const closeListeners = new Set<(event: unknown) => void>();
  return {
    id,
    resume: vi.fn(async (sessionId: string) => ({ id: sessionId })),
    get: vi.fn(),
    close: vi.fn(async () => {}),
    onDidCloseSession: vi.fn((listener: (event: unknown) => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    }),
    dispose: vi.fn(() => {}),
  };
}

function managerStub(
  seed: WorkspaceInstance[] = [],
  createInstance?: (ref: WorkspaceInstanceRef) => WorkspaceInstance,
) {
  const instances = new Map(seed.map((instance) => [instance.id, instance]));
  const changeListeners = new Set<
    (change: { workspaceId: string; instance?: WorkspaceInstance }) => void
  >();
  const getOrCreate = vi.fn(async (ref: WorkspaceInstanceRef) => {
    const found = (() => {
      if ('workspaceId' in ref && ref.workspaceId !== undefined) {
        const byId = instances.get(ref.workspaceId);
        if (byId !== undefined) return byId;
      }
      return [...instances.values()].find((instance) => instance.root === ref.root);
    })();
    if (found !== undefined) return found;
    if (createInstance === undefined) {
      throw new Error2(
        ErrorCodes.WORKSPACE_NOT_FOUND,
        `workspace ${'workspaceId' in ref ? ref.workspaceId : ref.root} does not exist`,
      );
    }
    const instance = createInstance(ref);
    instances.set(instance.id, instance);
    for (const listener of changeListeners) listener({ workspaceId: instance.id, instance });
    return instance;
  });
  const manager: IWorkspaceInstanceManager = {
    _serviceBrand: undefined,
    onDidChange: (listener) => {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },
    getOrCreate,
    get: (workspaceId) => instances.get(workspaceId),
    findByRoot: (root) => [...instances.values()].find((instance) => instance.root === root),
    findContaining: () => undefined,
    list: () => [...instances.values()],
    snapshot: () => ({ workspaces: [] }),
    close: async () => {},
    addProvider: async () => ({ dispose: () => {} }),
  };
  const fire = (workspaceId: string, instance: WorkspaceInstance): void => {
    instances.set(workspaceId, instance);
    for (const listener of changeListeners) listener({ workspaceId, instance });
  };
  return { manager, fire, getOrCreate };
}

function sessionManagerStub(
  sessions: readonly { readonly id: string; readonly workspaceId: string }[],
) {
  const live = new Map(
    sessions.map(({ id, workspaceId }) => [
      id,
      {
        id,
        accessor: {
          get: <T>(token: unknown): T =>
            token === ISessionContext ? ({ workspaceId } as T) : (undefined as T),
        },
      },
    ]),
  );
  return {
    _serviceBrand: undefined,
    list: () => [...live.values()],
    get: (sessionId: string) => live.get(sessionId),
    resume: async (sessionId: string) => live.get(sessionId),
    close: async () => undefined,
  } as unknown as ISessionManager;
}

function sessionIndexStub(): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: () => Promise.resolve({ state: 'ready', generation: 0, degradedCount: 0 }),
    status: () => ({ state: 'ready', generation: 0, degradedCount: 0 }),
    get: () => Promise.resolve(undefined),
    listRecent: () => Promise.resolve({ items: [] }),
    count: () => Promise.resolve(0),
    remove: () => Promise.resolve(),
  };
}

describe('WorkspaceLifecycleService', () => {
  let host: ScopedTestHost | undefined;
  let telemetryRecords: TelemetryRecord[];

  beforeEach(() => {
    telemetryRecords = [];
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceLifecycleService,
      WorkspaceLifecycleService,
      ScopeActivation.OnDemand,
      'workspaceLifecycle',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function build(
    options: {
      instances?: WorkspaceInstance[];
      sessions?: readonly { readonly id: string; readonly workspaceId: string }[];
      createInstance?: (ref: WorkspaceInstanceRef) => WorkspaceInstance;
      extra?: ReturnType<typeof stubPair>[];
    } = {},
  ): {
    lifecycle: IWorkspaceLifecycleService;
    manager: ReturnType<typeof managerStub>;
  } {
    const manager = managerStub(options.instances, options.createInstance);
    host = createScopedTestHost([
      stubPair(IWorkspaceInstanceManager, manager.manager),
      stubPair(ISessionManager, sessionManagerStub(options.sessions ?? [])),
      stubPair(ISessionIndex, sessionIndexStub()),
      stubPair(ITelemetryService, recordingTelemetry(telemetryRecords)),
      ...(options.extra ?? []),
    ]);
    return { lifecycle: host.app.accessor.get(IWorkspaceLifecycleService), manager };
  }

  it('handlerFor materializes a handler over the workspace instance', async () => {
    const controller = controllerStub('controller');
    const { lifecycle, manager } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });

    const handler = await lifecycle.handlerFor({ workspaceId: 'wd_proj' });

    expect(manager.getOrCreate).toHaveBeenCalledWith({ workspaceId: 'wd_proj' });
    expect(handler.id).toBe('wd_proj');
    expect(lifecycle.handlers.list().map((h) => h.id)).toEqual(['wd_proj']);
    expect(handler).toBe(lifecycle.handlers.list()[0]);
  });

  it('handlerFor by root delegates the root lookup to the manager', async () => {
    const controller = controllerStub('controller');
    const { lifecycle, manager } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });

    const handler = await lifecycle.handlerFor({ root: '/tmp/proj' });

    expect(manager.getOrCreate).toHaveBeenCalledWith({ root: '/tmp/proj' });
    expect(handler.id).toBe('wd_proj');
  });

  it('handlerFor returns the same handler for concurrent materializations', async () => {
    const controller = controllerStub('controller');
    const { lifecycle } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });

    const [a, b] = await Promise.all([
      lifecycle.handlerFor({ workspaceId: 'wd_proj' }),
      lifecycle.handlerFor({ workspaceId: 'wd_proj' }),
    ]);

    expect(a).toBe(b);
    expect(lifecycle.handlers.list()).toHaveLength(1);
  });

  it('handlerFor by unknown workspaceId without a root hint throws workspace.not_found', async () => {
    const { lifecycle } = build();

    await expect(lifecycle.handlerFor({ workspaceId: 'wd_missing' })).rejects.toMatchObject({
      code: ErrorCodes.WORKSPACE_NOT_FOUND,
    });
    expect(lifecycle.handlers.list()).toHaveLength(0);
  });

  it('sessions.list filters live sessions by workspace', () => {
    const { lifecycle } = build({
      sessions: [
        { id: 's1', workspaceId: 'wd_a' },
        { id: 's2', workspaceId: 'wd_a' },
        { id: 's3', workspaceId: 'wd_b' },
      ],
    });

    expect(lifecycle.sessions.list('wd_a').toSorted()).toEqual(['s1', 's2']);
    expect(lifecycle.sessions.list('wd_b')).toEqual(['s3']);
    expect(lifecycle.sessions.list('wd_missing')).toEqual([]);
  });

  it('onDidMaterializeHandler forwards manager materializations', async () => {
    const controller = controllerStub('controller');
    const { lifecycle, manager } = build();
    const materialized: string[] = [];
    lifecycle.onDidMaterializeHandler((handler) => materialized.push(handler.id));

    const instance = fakeInstance('wd_proj', '/tmp/proj', controller);
    manager.fire('wd_proj', instance);

    expect(materialized).toEqual(['wd_proj']);
    expect(lifecycle.handlers.list().map((h) => h.id)).toEqual(['wd_proj']);
  });

  it('handle accessor resolves a cached ISessionLifecycleService controller', async () => {
    const controller = controllerStub('controller');
    const { lifecycle } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });
    const handler = await lifecycle.handlerFor({ workspaceId: 'wd_proj' });

    const first = handler.accessor.get(ISessionLifecycleService);
    const second = handler.accessor.get(ISessionLifecycleService);

    expect(first).toBe(second);
    expect(first).toBe(controller);
  });

  it('handle accessor rejects unknown service ids', async () => {
    const controller = controllerStub('controller');
    const { lifecycle } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });
    const handler = await lifecycle.handlerFor({ workspaceId: 'wd_proj' });

    expect(() => handler.accessor.get(ISessionIndex)).toThrow(
      /only resolves ISessionLifecycleService/,
    );
  });

  it('handle.dispose disposes the cached controller', async () => {
    const controller = controllerStub('controller');
    const { lifecycle } = build({
      instances: [fakeInstance('wd_proj', '/tmp/proj', controller)],
    });
    const handler = await lifecycle.handlerFor({ workspaceId: 'wd_proj' });

    handler.accessor.get(ISessionLifecycleService);
    handler.dispose();

    expect(controller.dispose).toHaveBeenCalledTimes(1);
    const again = await lifecycle.handlerFor({ workspaceId: 'wd_proj' });
    expect(again).not.toBe(handler);
    again.accessor.get(ISessionLifecycleService);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });

  describe('sessionLookup', () => {
    it('resumeSessionById routes to the session manager', async () => {
      const resume = vi.fn(async () => ({ id: 's1' }));
      build({
        extra: [
          stubPair(ISessionManager, {
            ...sessionManagerStub([]),
            resume,
          } as unknown as ISessionManager),
        ],
      });

      const handle = await resumeSessionById(host!.app.accessor, 's1');

      expect(handle?.id).toBe('s1');
      expect(resume).toHaveBeenCalledWith('s1', undefined);
    });

    it('resumeSessionById returns undefined for an unknown session', async () => {
      build();
      await expect(resumeSessionById(host!.app.accessor, 'nope')).resolves.toBeUndefined();
    });

    it('resumeSessionById reports session_load_failed when the resume fails', async () => {
      build({
        extra: [
          stubPair(ISessionManager, {
            ...sessionManagerStub([]),
            resume: () => Promise.reject(new Error2(ErrorCodes.SESSION_NOT_FOUND, 'resume failed')),
          } as unknown as ISessionManager),
        ],
      });

      await expect(resumeSessionById(host!.app.accessor, 's1')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      expect(telemetryRecords).toContainEqual({
        event: 'session_load_failed',
        properties: { sessionId: 's1', reason: ErrorCodes.SESSION_NOT_FOUND },
      });
    });

    it('getLiveSessionById finds only live sessions', async () => {
      build({
        sessions: [{ id: 's1', workspaceId: 'wd_proj' }],
      });

      expect(getLiveSessionById(host!.app.accessor, 's1')?.id).toBe('s1');
      expect(getLiveSessionById(host!.app.accessor, 'other')).toBeUndefined();
    });

    it('followWorkspaceHandlers subscribes present and future handlers', async () => {
      const firstController = controllerStub('controller-a');
      const secondController = controllerStub('controller-b');
      const { lifecycle } = build({
        instances: [fakeInstance('wd_a', '/tmp/a', firstController)],
        createInstance: (ref) => {
          const workspaceId =
            'workspaceId' in ref && ref.workspaceId !== undefined ? ref.workspaceId : 'wd_b';
          const root = 'root' in ref && ref.root !== undefined ? ref.root : '/tmp/b';
          return fakeInstance(workspaceId, root, secondController);
        },
      });
      const closed: string[] = [];
      const sub = followWorkspaceHandlers(host!.app.accessor, (service) =>
        service.onDidCloseSession((event) =>
          closed.push((event as { sessionId: string }).sessionId),
        ),
      );

      await lifecycle.handlerFor({ workspaceId: 'wd_a' });
      await lifecycle.handlerFor({ workspaceId: 'wd_b' });

      const fire = (controller: FakeController, sessionId: string): void => {
        const listener = controller.onDidCloseSession.mock.calls[0]?.[0] as
          | ((event: unknown) => void)
          | undefined;
        listener?.({ sessionId });
      };
      fire(firstController, 's1');
      fire(secondController, 's2');

      expect(closed.toSorted()).toEqual(['s1', 's2']);
      sub.dispose();
    });
  });
});
