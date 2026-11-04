import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PluginAvailabilityStore,
  pluginAvailabilitySourceKey,
} from '#/app/plugin/availability';
import type { PluginMarketplace } from '#/app/plugin/marketplace';

const MARKET = 'https://market.example/plugins/marketplace';

function marketplace(plugins: PluginMarketplace['plugins'], source = MARKET): PluginMarketplace {
  return { source, plugins };
}

async function withStore(run: (store: PluginAvailabilityStore, home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'plugin-availability-'));
  try {
    await run(new PluginAvailabilityStore(home), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('PluginAvailabilityStore.update', () => {
  it('writes the catalog and reports a change only once', async () => {
    await withStore(async (store, home) => {
      const market = marketplace([
        { id: 'sample', displayName: 'Sample', source: 'https://example.com/sample.zip', clients: ['cli'], platforms: ['linux'] },
      ]);

      await expect(store.update(market)).resolves.toBe(true);
      const generation = store.generation;
      await expect(store.update(market)).resolves.toBe(false);
      expect(store.generation).toBe(generation);

      const written = JSON.parse(
        await readFile(join(home, 'plugins', 'availability.json'), 'utf8'),
      ) as { version: number; sources: Record<string, Record<string, unknown>> };
      expect(written.version).toBe(1);
      expect(Object.keys(written.sources)).toEqual([pluginAvailabilitySourceKey(MARKET)]);
      expect(written.sources[pluginAvailabilitySourceKey(MARKET)]?.['sample']).toMatchObject({
        clients: ['cli'],
        platforms: ['linux'],
      });
    });
  });

  it('survives two concurrent updates without corrupting the cache', async () => {
    await withStore(async (store) => {
      const first = marketplace([
        { id: 'one', displayName: 'One', source: 'https://example.com/one.zip' },
      ]);
      const second = marketplace(
        [{ id: 'two', displayName: 'Two', source: 'https://example.com/two.zip' }],
        'https://other.example/plugins/marketplace',
      );

      await Promise.all([store.update(first), store.update(second)]);

      await store.refresh();
      expect(store.entryFor({ id: 'one', origin: 'marketplace', catalogId: 'one' })).toBeDefined();
      expect(store.entryFor({ id: 'two', origin: 'marketplace', catalogId: 'two' })).toBeDefined();
    });
  });

  it('reclaims a stale lock left behind by a crashed writer', async () => {
    await withStore(async (store, home) => {
      await mkdir(join(home, 'plugins'), { recursive: true });
      const lockPath = join(home, 'plugins', 'availability.json.lock');
      await writeFile(lockPath, '', 'utf8');
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      await expect(
        store.update(
          marketplace([{ id: 'stale', displayName: 'Stale', source: 'https://example.com/s.zip' }]),
        ),
      ).resolves.toBe(true);
    });
  });
});

describe('PluginAvailabilityStore lookups', () => {
  async function seeded(): Promise<PluginAvailabilityStore> {
    const store = new PluginAvailabilityStore(await mkdtemp(join(tmpdir(), 'plugin-av-lookup-')));
    await store.update(
      marketplace([
        {
          id: 'desktop-only',
          displayName: 'Desktop only',
          source: 'https://example.com/desktop.zip',
          clients: ['desktop'],
          platforms: ['darwin'],
        },
      ]),
    );
    return store;
  }

  it('treats a custom plugin as always supported', async () => {
    const store = await seeded();
    expect(store.entryFor({ id: 'anything', origin: 'custom' })).toBeUndefined();
    expect(store.supports({ id: 'anything', origin: 'custom' }, 'cli', 'win32')).toBe(true);
  });

  it('matches a marketplace plugin by its catalog entry', async () => {
    const store = await seeded();
    const record = {
      id: 'installed-desktop',
      origin: 'marketplace' as const,
      catalogId: 'desktop-only',
      marketplaceSource: MARKET,
    };

    expect(store.supports(record, 'desktop', 'darwin')).toBe(true);
    expect(store.supports(record, 'cli', 'darwin')).toBe(false);
    expect(store.supports(record, 'desktop', 'linux')).toBe(false);
  });

  it('requires provenance to match for an unknown origin', async () => {
    const store = await seeded();
    expect(
      store.entryFor({
        id: 'desktop-only',
        origin: 'unknown',
        originalSource: 'https://example.com/desktop.zip',
      }),
    ).toBeDefined();
    expect(
      store.entryFor({
        id: 'desktop-only',
        origin: 'unknown',
        originalSource: 'https://example.com/different.zip',
      }),
    ).toBeUndefined();
  });

  it('resolves a marketplace install source back to its catalog entry', async () => {
    const store = await seeded();
    expect(store.matchByArtifact('https://example.com/desktop.zip')).toEqual({
      marketplaceSource: pluginAvailabilitySourceKey(MARKET),
      catalogId: 'desktop-only',
    });
    expect(store.matchByArtifact('https://example.com/not-in-catalog.zip')).toBeUndefined();
  });

  it('treats a plugin the cache has never seen as supported', async () => {
    const store = await seeded();
    expect(
      store.supports(
        { id: 'missing', origin: 'marketplace', catalogId: 'missing', marketplaceSource: MARKET },
        'cli',
        'linux',
      ),
    ).toBe(true);
  });
});

describe('PluginAvailabilityStore.refresh', () => {
  it('rejects a corrupt cache instead of inventing an empty one', async () => {
    await withStore(async (store, home) => {
      await mkdir(join(home, 'plugins'), { recursive: true });
      await writeFile(join(home, 'plugins', 'availability.json'), '{ not json', 'utf8');
      await expect(store.refresh()).rejects.toThrow();
    });
  });
});
