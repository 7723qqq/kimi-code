import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { MemoryEntry } from '#/app/memory/memoryPaths';
import { IMemoryStore, MemoryStore } from '#/app/memory/memoryStore';
import { LifecycleScope } from '#/app/scopes';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

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

  it('refuses writes once the associative memory has absorbed it', async () => {
    const dir = join(homeDir, 'memory', 'global');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'alpha.md'), '# alpha\nbody', 'utf-8');
    const store = build();
    expect(store.readOnly).toBe(false);
    store.setReadOnly(true);
    expect(store.readOnly).toBe(true);
    await expect(store.put(entry('global/b.md', 'other'))).rejects.toThrow(/read-only/);
    await expect(store.delete('global/alpha.md')).rejects.toThrow(/read-only/);
    await expect(store.get('global/alpha.md')).resolves.toBeDefined();
  });

  it('indexes files written to disk, then lists and searches them', async () => {
    const dir = join(homeDir, 'memory', 'global');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'alpha.md'), '# alpha\nprefers pnpm over npm', 'utf-8');
    await fsp.writeFile(join(dir, 'beta.md'), '# beta\nunrelated body', 'utf-8');

    const store = build();
    expect(await store.get('global/alpha.md')).toMatchObject({ title: 'alpha' });
    expect(await store.list()).toEqual(['global/alpha.md', 'global/beta.md']);
    const hits = await store.search('pnpm');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe('global/alpha.md');
  });

  it('advances the content revision on every mutation', async () => {
    const store = build();
    const start = store.revision;
    await store.put(entry('global/alpha.md', 'body'));
    expect(store.revision).toBeGreaterThan(start);
    const afterPut = store.revision;
    await store.delete('global/alpha.md');
    expect(store.revision).toBeGreaterThan(afterPut);
    const afterDelete = store.revision;
    await store.reconcile();
    expect(store.revision).toBeGreaterThan(afterDelete);
  });

  it('aligns the index with files added or removed on disk', async () => {
    const dir = join(homeDir, 'memory', 'global');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'alpha.md'), '# alpha\nbody', 'utf-8');
    const store = build();
    expect(await store.list()).toEqual(['global/alpha.md']);

    await fsp.writeFile(join(dir, 'beta.md'), '# beta\nbody', 'utf-8');
    await store.reconcile();
    expect(await store.list()).toEqual(['global/alpha.md', 'global/beta.md']);

    await fsp.unlink(join(dir, 'alpha.md'));
    await store.reconcile();
    expect(await store.list()).toEqual(['global/beta.md']);
    expect(await store.get('global/alpha.md')).toBeUndefined();
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
