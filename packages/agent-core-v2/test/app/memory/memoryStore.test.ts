import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IMemoryStore, MemoryStore } from '#/app/memory/memoryStore';
import type { MemoryEntry } from '#/app/memory/memoryPaths';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

function entry(path: string, body: string): MemoryEntry {
  return {
    path,
    scope: 'global',
    scopeId: '',
    type: 'note',
    title: path,
    body,
    fingerprint: 'fp',
    updatedAt: 1,
  };
}

describe('MemoryStore', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IMemoryStore,
      MemoryStore,
      ScopeActivation.OnDemand,
      'memory',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'memory-store-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): IMemoryStore {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(IMemoryStore);
  }

  it('stores, lists, and searches memory entries', async () => {
    const store = build();
    await store.put(entry('global/alpha.md', 'prefers pnpm over npm'));
    await store.put(entry('global/beta.md', 'unrelated body'));
    expect(await store.get('global/alpha.md')).toMatchObject({ title: 'global/alpha.md' });
    expect(await store.list()).toEqual(['global/alpha.md', 'global/beta.md']);
    const hits = await store.search('pnpm');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('global/alpha.md');
  });

  it('never deletes user data when the store is corrupt and degrades with a clear error', async () => {
    const storeDir = join(homeDir, 'store', 'memory');
    await fsp.mkdir(storeDir, { recursive: true });
    const corruptSidecar = '{ not valid json';
    await fsp.writeFile(join(storeDir, 'db.indexes.json'), corruptSidecar);

    const store = build();
    await expect(store.get('global/alpha.md')).rejects.toThrow(/failed to open/);
    await expect(store.put(entry('global/alpha.md', 'body'))).rejects.toThrow(/failed to open/);

    expect(await fsp.readFile(join(storeDir, 'db.indexes.json'), 'utf8')).toBe(corruptSidecar);
    expect(await fsp.readdir(storeDir)).toContain('db.indexes.json');
  });
});
