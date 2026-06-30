import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/bootstrap';
import { ISessionIndex } from '#/session-index/sessionIndex';
import { FileSessionIndex } from '#/session-index/sessionIndexService';
import {
  AtomicDocumentStore,
  FileStorageService,
  IAtomicDocumentStore,
  IStorageService,
} from '#/storage';

const WORK_DIR = '/home/user/repo';

describe('FileSessionIndex', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, ISessionIndex, FileSessionIndex, InstantiationType.Delayed, 'session-index');
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-'));
    sessionsDir = join(homeDir, 'sessions');
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): ISessionIndex {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new AtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, { homeDir, sessionsDir } as IBootstrapService),
    ]);
    disposeHost = () => host.dispose();
    return host.app.accessor.get(ISessionIndex);
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, 'session-meta');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  async function seedEmpty(sessionId: string, wsId: string = workspaceId): Promise<void> {
    await fsp.mkdir(join(sessionsDir, wsId, sessionId), { recursive: true });
  }

  it('list returns non-archived sessions by default', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    const page = await store.list({ workspaceId });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['active']);
    expect(page.items[0]?.workspaceId).toBe(workspaceId);
    expect(page.items[0]?.archived).toBe(false);
  });

  it('list includes archived when requested', async () => {
    await seedSession('active', {});
    await seedSession('archived', { archived: true });

    const store = build();
    const page = await store.list({ workspaceId, includeArchived: true });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['active', 'archived']);
  });

  it('get fetches a session by id across workspaces', async () => {
    await seedSession('active', { title: 'hello' });

    const store = build();
    const summary = await store.get('active');
    expect(summary?.id).toBe('active');
    expect(summary?.title).toBe('hello');
    expect(await store.get('missing')).toBeUndefined();
  });

  it('countActive counts non-archived sessions', async () => {
    await seedSession('a', {});
    await seedSession('b', {});
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    expect(await store.countActive(workspaceId)).toBe(2);
    expect(await store.countActive('wd_unknown')).toBe(0);
  });
});
