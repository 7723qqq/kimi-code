import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IEnvironmentService } from '#/environment/environment';
import { IEventService, type ProtocolEvent } from '#/event/event';
import { ILogService } from '#/log/log';
import { ISessionStore } from '#/sessionStore/sessionStore';
import { WorkspaceError, WorkspaceErrors } from '#/workspace/errors';
import { IWorkspaceRegistry } from '#/workspace/workspaceRegistry';
import { WorkspaceRegistryService } from '#/workspace/workspaceRegistryService';

import { stubLog } from '../log/stubs';

function stubEnv(homeDir: string): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
    detect: async () => {
      throw new Error('not implemented in test');
    },
  };
}

function stubEventBus(): { service: IEventService; events: ProtocolEvent[] } {
  const events: ProtocolEvent[] = [];
  return {
    events,
    service: {
      _serviceBrand: undefined,
      publish: (e) => {
        events.push(e);
      },
      subscribe: () => ({ dispose() {} }),
    },
  };
}

function stubSessionStore(sessionCount: () => number): ISessionStore {
  return {
    _serviceBrand: undefined,
    sessionDir: (root, workDir, sessionId) => join(root, workDir.replace(/[^a-z0-9]/gi, '_'), sessionId),
    workspaceIdFor: (workDir) => `wd_${workDir.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`,
    countActiveSessions: async () => sessionCount(),
  };
}

describe('WorkspaceRegistryService', () => {
  let homeDir: string;
  let rootDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      IWorkspaceRegistry,
      WorkspaceRegistryService,
      InstantiationType.Delayed,
      'workspace',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-reg-home-'));
    // Canonicalize: createOrTouch realpaths the root, so assertions must compare
    // against the real path (macOS maps /var/folders -> /private/var/folders).
    rootDir = await fsp.realpath(await fsp.mkdtemp(join(os.tmpdir(), 'ws-reg-root-')));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  function build(sessionCount: () => number = () => 0) {
    const eventStub = stubEventBus();
    const host = createScopedTestHost([
      stubPair(IEnvironmentService, stubEnv(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IEventService, eventStub.service),
      stubPair(ISessionStore, stubSessionStore(sessionCount)),
    ]);
    disposeHost = () => host.dispose();
    return { registry: host.core.accessor.get(IWorkspaceRegistry), events: eventStub.events };
  }

  it('creates a new workspace and lists it', async () => {
    const { registry } = build();
    const ws = await registry.createOrTouch(rootDir, 'my-repo');
    expect(ws.name).toBe('my-repo');
    expect(ws.root).toBe(rootDir);
    expect(ws.is_git_repo).toBe(false);

    const all = await registry.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(ws.id);
  });

  it('is idempotent on the same root and bumps last_opened_at', async () => {
    const { registry } = build();
    const first = await registry.createOrTouch(rootDir);
    const second = await registry.createOrTouch(rootDir);
    expect(second.id).toBe(first.id);
    expect(new Date(second.last_opened_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.last_opened_at).getTime(),
    );
    expect(await registry.list()).toHaveLength(1);
  });

  it('throws fs.path_not_found when root does not exist', async () => {
    const { registry } = build();
    const missing = join(rootDir, 'does-not-exist');
    await expect(registry.createOrTouch(missing)).rejects.toMatchObject({
      code: WorkspaceErrors.codes.PATH_NOT_FOUND,
    });
  });

  it('renames a workspace', async () => {
    const { registry } = build();
    const ws = await registry.createOrTouch(rootDir, 'old');
    const updated = await registry.update(ws.id, { name: 'new' });
    expect(updated.name).toBe('new');
    expect((await registry.get(ws.id)).name).toBe('new');
  });

  it('deletes a workspace', async () => {
    const { registry } = build();
    const ws = await registry.createOrTouch(rootDir);
    await registry.delete(ws.id);
    expect(await registry.list()).toHaveLength(0);
    await expect(registry.get(ws.id)).rejects.toMatchObject({
      code: WorkspaceErrors.codes.WORKSPACE_NOT_FOUND,
    });
  });

  it('resolves a workspace id back to its root', async () => {
    const { registry } = build();
    const ws = await registry.createOrTouch(rootDir);
    expect(await registry.resolveRoot(ws.id)).toBe(rootDir);
  });

  it('throws workspace.not_found for an unknown id', async () => {
    const { registry } = build();
    await expect(registry.get('wd_unknown_000000000000')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(registry.get('wd_unknown_000000000000')).rejects.toMatchObject({
      code: WorkspaceErrors.codes.WORKSPACE_NOT_FOUND,
    });
  });

  it('publishes a created event only on first registration', async () => {
    const { registry, events } = build();
    await registry.createOrTouch(rootDir);
    await registry.createOrTouch(rootDir);
    const created = events.filter((e) => e.type === 'event.workspace.created');
    expect(created).toHaveLength(1);
    expect((created[0]!.payload as { workspace: { root: string } }).workspace.root).toBe(rootDir);
  });

  it('reports session_count from the session store', async () => {
    let count = 3;
    const { registry } = build(() => count);
    const ws = await registry.createOrTouch(rootDir);
    expect(ws.session_count).toBe(3);
    count = 7;
    expect((await registry.get(ws.id)).session_count).toBe(7);
  });
});
