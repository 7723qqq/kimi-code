// test/cluster/basic.test.ts
//
// Single-process ClusterDb behavior: topology creation/validation, basic KV
// across shards, multi-key ops, merged scans, hash distribution, stats.

import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { ClusterDb, shardDirName } from '../../src/cluster/index.js';
import { shardFor } from '../../src/cluster/utils.js';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';
import { keyOnShard, keysByShard } from './helpers.js';

interface User {
  name: string;
  age: number;
}

test('cluster open creates meta + shard dirs; reload validates topology', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    expect(db.shardCount).toBe(4);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'cluster.meta.json'), 'utf8'));
    expect(meta.version).toBe(1);
    expect(meta.shardCount).toBe(4);
    expect(meta.valueCodec).toBe('json');
    const entries = await fs.readdir(dir);
    for (let i = 0; i < 4; i++) expect(entries.includes(`shard-0${i}`), `shard-0${i} exists`).toBeTruthy();
    await db.close();

    // Reopen without options: inherits the on-disk topology.
    const db2 = await ClusterDb.open({ dir });
    expect(db2.shardCount).toBe(4);
    await db2.close();

    // Explicit mismatches are rejected.
    await expect((() => ClusterDb.open({ dir, shardCount: 8 }))()).rejects.toThrow(/shardCount=4/);
    await expect((() => ClusterDb.open({ dir, valueCodec: 'string' }))()).rejects.toThrow(/valueCodec=json/);

    // Invalid creation parameter is rejected upfront.
    const dir2 = await tmpDir('minidb-cluster-');
    try {
      await expect((() => ClusterDb.open({ dir: dir2, shardCount: 0 }))()).rejects.toThrow(RangeError);
    } finally {
      await rmrf(dir2);
    }
  } finally {
    await rmrf(dir);
  }
});

test('single-key ops round-trip across shards', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<User>({ dir, shardCount: 4, valueCodec: 'json' });
    // Keys crafted to hit two distinct shards, proving reads/writes route.
    const k0 = keyOnShard('round', 0, 4);
    const k1 = keyOnShard('round', 1, 4);
    await db.set(k0, { name: 'alice', age: 30 });
    await db.set(k1, { name: 'bob', age: 25 });
    expect(await db.get(k0)).toStrictEqual({ name: 'alice', age: 30 });
    expect(await db.get(k1)).toStrictEqual({ name: 'bob', age: 25 });
    expect(await db.has(k0)).toBe(true);
    expect(await db.has('round:nope')).toBe(false);
    expect(await db.del(k0)).toBe(true);
    expect(await db.del(k0)).toBe(false);
    expect(await db.get(k0)).toBe(undefined);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('ttl and expire work per key', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<string>({ dir, shardCount: 2, valueCodec: 'string' });
    await db.set('temp', 'v', { ttl: 50 });
    const left = await db.ttl('temp');
    expect(left > 0 && left <= 50, `ttl in range, got ${left}`).toBeTruthy();
    expect(await db.ttl('missing')).toBe(-2);
    await db.set('forever', 'v');
    expect(await db.ttl('forever')).toBe(-1);
    expect(await db.expire('forever', 30)).toBe(true);
    expect(await db.expire('missing', 30)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(await db.get('temp')).toBe(undefined);
    expect(await db.get('forever')).toBe(undefined);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('mset/mget/mdel span shards (atomic per shard)', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<number>({ dir, shardCount: 8, valueCodec: 'json' });
    const grouped = keysByShard('multi', 200, 8);
    expect(grouped.size >= 3, `keys hit multiple shards, got ${grouped.size}`).toBeTruthy();

    const entries = [...grouped.values()].flat().map((k, i) => [k, i] as [string, number]);
    await db.mset(entries);

    const keys = entries.map(([k]) => k);
    const got = await db.mget(keys);
    expect(got).toStrictEqual(entries.map(([, v]) => v));

    // mdel counts real deletions and spans shards.
    const some = keys.filter((_, i) => i % 2 === 0);
    const removed = await db.mdel([...some, 'multi:never-existed']);
    expect(removed).toBe(some.length);
    const after = await db.mget(some);
    expect(after.every((v) => v === undefined)).toBeTruthy();
    const rest = await db.mget(keys.filter((_, i) => i % 2 === 1));
    expect(rest.every((v) => typeof v === 'number')).toBeTruthy();
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('batch applies per-shard atomically with ttl/dt', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<User>({ dir, shardCount: 4, valueCodec: 'json' });
    const grouped = keysByShard('batch', 40, 4);
    const ops = [...grouped.values()].flat().flatMap((k, i) => [
      { op: 'set' as const, key: k, value: { name: `u${i}`, age: i }, dt: { created: 1000 + i } },
      { op: 'del' as const, key: `ghost:${i}` },
    ]);
    await db.batch(ops);
    const all = await db.scan({ prefix: 'batch:' });
    expect(all.length).toBe(40);
    expect(all.every((e) => e.dt && typeof e.dt.created === 'number')).toBeTruthy();
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test(
  'scan/prefix merge across shards: sorted, bounded, limited, reversible',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-cluster-');
    try {
      const db = await ClusterDb.open<number>({ dir, shardCount: 8, valueCodec: 'json' });
      const keys: string[] = [];
      for (let i = 0; i < 300; i++) {
        const k = `s:${String(i).padStart(4, '0')}`;
        keys.push(k);
        await db.set(k, i);
      }
      const byteSorted = [...keys].toSorted((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );

      const all = await db.scan();
      expect(all.length).toBe(300);
      expect(all.map((e) => e.key), 'globally sorted by key bytes').toStrictEqual(byteSorted);

      // Interleaved writes land in every shard; the merge must be complete.
      const range = await db.scan({ gte: 's:0010', lt: 's:0020' });
      expect(range.map((e) => e.key)).toStrictEqual(byteSorted.filter((k) => k >= 's:0010' && k < 's:0020'));

      const pref = await db.prefix('s:01', 10);
      expect(pref.length).toBe(10);
      expect(pref.map((e) => e.key)).toStrictEqual(byteSorted.filter((k) => k.startsWith('s:01')).slice(0, 10));

      const limited = await db.scan({ limit: 7 });
      expect(limited.length).toBe(7);
      expect(limited.map((e) => e.key)).toStrictEqual(byteSorted.slice(0, 7));

      const rev = await db.scan({ reverse: true, limit: 5 });
      expect(rev.map((e) => e.key)).toStrictEqual([...byteSorted].toReversed().slice(0, 5));

      // Prefix within ScanOptions beats range bounds.
      const prefOpt = await db.scan({ prefix: 's:029', gte: 'zzz' });
      expect(prefOpt.map((e) => e.key)).toStrictEqual([
          's:0290',
          's:0291',
          's:0292',
          's:0293',
          's:0294',
          's:0295',
          's:0296',
          's:0297',
          's:0298',
          's:0299',
        ].filter((k) => k.startsWith('s:029')));
      await db.close();
    } finally {
      await rmrf(dir);
    }
  },
);

test('hash routing distributes keys over all shards and is deterministic', async () => {
  const counts = Array.from({ length: 16 }, () => 0);
  for (let i = 0; i < 4000; i++) counts[shardFor(`dist:${i}`, 16)]++;
  const avg = 4000 / 16;
  for (let s = 0; s < 16; s++) {
    expect(counts[s]! > 0, `shard ${s} got keys`).toBeTruthy();
    expect(counts[s]! < avg * 3, `shard ${s} not hot (${counts[s]} vs avg ${avg})`).toBeTruthy();
  }
  // Stable across calls (crypto-free pure function).
  expect(shardFor('dist:42', 16)).toBe(shardFor('dist:42', 16));
  expect(shardFor('', 16)).toBe(shardFor('', 16)); // empty key hashes fine
});

test('stats reflect writer usage', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<string>({
      dir,
      shardCount: 4,
      valueCodec: 'string',
      lockPoolMaxShards: 2,
    });
    for (let i = 0; i < 20; i++) await db.set(`st:${i}`, 'v');
    const s = db.stats();
    expect(s.shardCount).toBe(4);
    expect(s.writerOpens >= 2, `writers opened, got ${s.writerOpens}`).toBeTruthy();
    expect(s.writersCached <= 2, `pool bounded, got ${s.writersCached}`).toBeTruthy();
    expect(s.evictions >= 1, 'LRU eviction happened with tiny pool').toBeTruthy();
    await db.close();
    await expect((() => db.get('st:0'))()).rejects.toThrow(/closed/);
  } finally {
    await rmrf(dir);
  }
});

interface QueryDoc {
  g: string;
  n: number;
}

test('query() merges filter + sort + skip/limit across shards', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<QueryDoc>({ dir, shardCount: 4, valueCodec: 'json' });
    // The four globally-highest n values all sit on shard 0: a per-shard
    // fetch must take skip+limit rows or a global page would lose them.
    for (const [i, n] of [100, 101, 102, 103].entries()) {
      const key = keyOnShard(`high${i}`, 0, 4);
      await db.set(key, { g: 'x', n });
    }
    // 40 filler docs with lower n, hash-scattered over all shards.
    const filler: string[] = [];
    for (let i = 0; i < 40; i++) {
      filler.push(`q:${i}`);
      await db.set(`q:${i}`, { g: 'x', n: i });
    }

    const sorted = (rows: { value: QueryDoc | undefined }[]) => rows.map((e) => e.value!.n);
    const page1 = await db.query({ filter: { g: 'x' }, sort: { n: -1 }, limit: 2 });
    expect(sorted(page1)).toStrictEqual([103, 102]);
    const page2 = await db.query({ filter: { g: 'x' }, sort: { n: -1 }, skip: 2, limit: 2 });
    expect(sorted(page2)).toStrictEqual([101, 100]);
    const page3 = await db.query({ filter: { g: 'x' }, sort: { n: -1 }, skip: 4, limit: 2 });
    expect(sorted(page3)).toStrictEqual([39, 38]);

    // Without an explicit sort the global order is key bytes (as in scan).
    const unordered = await db.query({ key: { prefix: 'q:' } });
    expect(unordered.map((e) => e.key)).toStrictEqual(filler.toSorted());

    // An unfiltered, unbounded query sees every doc exactly once.
    const all = await db.query();
    expect(all.length).toBe(44);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('compound index definitions fan out to all shards and survive reopen', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<QueryDoc>({ dir, shardCount: 4, valueCodec: 'json' });
    await db.set(keyOnShard('ci', 0, 4), { g: 'x', n: 1 });
    await db.createCompoundIndex('byGN', { groupBy: 'g', orderBy: 'n' });
    const info = [{ name: 'byGN', groupBy: 'g', orderBy: 'n', orderType: 'number' }];
    expect(await db.listCompoundIndexes()).toStrictEqual(info);

    // Every shard applied the definition (verified through its own sidecar).
    for (let id = 0; id < 4; id++) {
      const shard = await MiniDb.open({
        dir: path.join(dir, shardDirName(id, 4)),
        valueCodec: 'json',
        readOnly: true,
      });
      try {
        expect(shard.listCompoundIndexes().some((i) => i.name === 'byGN'), `shard ${id} has the index`).toBeTruthy();
      } finally {
        await shard.close();
      }
    }

    // A duplicate create is rejected, and the registry round-trips a reopen.
    await expect((() => db.createCompoundIndex('byGN', { groupBy: 'g', orderBy: 'n' }))()).rejects.toThrow(/already exists/);
    await db.close();
    const db2 = await ClusterDb.open<QueryDoc>({ dir, shardCount: 4, valueCodec: 'json' });
    expect(await db2.listCompoundIndexes()).toStrictEqual(info);
    expect(await db2.dropCompoundIndex('byGN')).toBe(true);
    expect(await db2.listCompoundIndexes()).toStrictEqual([]);
    expect(await db2.dropCompoundIndex('byGN')).toBe(false);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});
