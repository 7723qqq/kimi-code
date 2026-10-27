// test/cluster/cross-shard.test.ts
//
// Cross-shard semantics: best-effort mset, 'none' mode rejection, per-shard
// secondary/text indexes with global merge, and cluster-wide compaction.

import assert from 'node:assert/strict';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { ClusterDb, shardDirName } from '../../src/cluster/index.js';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';
import { keyOnShard, keysByShard } from './helpers.js';

test("crossShard 'none' rejects multi-shard writes but allows single-shard ones", async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<number>({
      dir,
      shardCount: 4,
      valueCodec: 'json',
      crossShard: 'none',
    });
    const a = keyOnShard('cs', 0, 4);
    const b = keyOnShard('cs', 1, 4);
    await assert.rejects(
      () =>
        db.mset([
          [a, 1],
          [b, 2],
        ]),
      /spans 2 shards/,
    );

    const sameShard = [keyOnShard('one', 0, 4), keyOnShard('one-x', 0, 4)];
    await db.mset(sameShard.map((k, i) => [k, i] as [string, number]));
    expect(await db.mget(sameShard)).toStrictEqual([0, 1]);
    await db.close();

    // '2pc' is explicitly reserved.
    await assert.rejects(() => ClusterDb.open({ dir, crossShard: '2pc' }), /2pc/);
  } finally {
    await rmrf(dir);
  }
});

test('secondary index: create, findEq/findRange merged across shards, maintained on new writes, drop', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface U {
      city: string;
      age: number;
    }
    const db = await ClusterDb.open<U>({ dir, shardCount: 8, valueCodec: 'json' });
    const keys = [...keysByShard('u', 120, 8).values()].flat();
    const expectedBj: string[] = [];
    await db.mset(
      keys.map((k, i) => {
        const u = { city: i % 3 === 0 ? 'bj' : 'sh', age: 20 + (i % 40) };
        if (u.city === 'bj') expectedBj.push(k);
        return [k, u] as [string, U];
      }),
    );
    // Sanity: data hit several shards, so index queries must merge.
    expect(keysByShard('u', 120, 8).size >= 3).toBeTruthy();

    await db.createIndex('by-city', { field: 'city' });
    await db.createIndex('by-age', { field: 'age', type: 'range' });

    const found = await db.findEq('by-city', 'bj');
    expect(found.map((r) => r.key).toSorted()).toStrictEqual([...expectedBj].toSorted());

    const ranged = await db.findRange('by-age', { min: 25, max: 30, maxExclusive: true });
    expect(ranged.length > 0).toBeTruthy();
    expect(ranged.every((r) => r.field >= 25 && r.field < 30)).toBeTruthy();
    // Sorted by field then key across shards.
    for (let i = 1; i < ranged.length; i++) expect(ranged[i]!.field >= ranged[i - 1]!.field).toBeTruthy();

    // Writes after index creation are indexed too (same-shard and elsewhere).
    const late = keyOnShard('late', 5, 8);
    await db.set(late, { city: 'bj', age: 33 });
    const after = await db.findEq('by-city', 'bj');
    expect(after.some((r) => r.key === late)).toBeTruthy();

    const defs = await db.listIndexes();
    expect(defs.map((d) => d.name).toSorted()).toStrictEqual(['by-age', 'by-city']);

    expect(await db.dropIndex('by-city')).toBe(true);
    await assert.rejects(() => db.findEq('by-city', 'bj'), /no such index/);
    expect(await db.dropIndex('by-city')).toBe(false);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('text index: search merges per-shard results by score', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface D {
      title: string;
      body: string;
    }
    const db = await ClusterDb.open<D>({ dir, shardCount: 8, valueCodec: 'json' });
    const docs: [string, D][] = [
      ['d:a', { title: 'rust wal', body: 'write ahead log durability in rust' }],
      ['d:b', { title: 'go wal', body: 'write ahead log implementations compared' }],
      ['d:c', { title: 'garden', body: 'tomatoes and basil on the balcony' }],
      ['d:d', { title: 'log blog', body: 'a blog about logging and logs' }],
      ['d:e', { title: 'rust garden', body: 'rust in the garden shed with tools' }],
    ];
    await db.mset(docs);
    // Make sure the corpus actually spans shards; otherwise the merge is untested.
    expect(new Set(docs.map(([k]) => db.shardOf(k))).size >= 2).toBeTruthy();

    await db.createTextIndex('txt', { fields: ['body'] });
    const hits = await db.search('txt', 'log');
    expect(hits.length >= 2).toBeTruthy();
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score >= hits[i]!.score).toBeTruthy();
    const keys = new Set(hits.map((h) => h.key));
    expect(keys.has('d:b') || keys.has('d:a') || keys.has('d:d')).toBeTruthy();

    const limited = await db.search('txt', 'rust OR log', { op: 'OR', limit: 2 });
    expect(limited.length).toBe(2);

    expect(await db.dropTextIndex('txt')).toBe(true);
    await assert.rejects(() => db.search('txt', 'log'), /no such text index/);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('index definitions survive reopen (registry applied on shard open)', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface U {
      city: string;
    }
    const db = await ClusterDb.open<U>({ dir, shardCount: 4, valueCodec: 'json' });
    await db.createIndex('by-city', { field: 'city' });
    await db.close();

    // A fresh instance writes new data; the registry must be applied to any
    // shard writer it opens so the index keeps being maintained.
    const db2 = await ClusterDb.open<U>({ dir, shardCount: 4, valueCodec: 'json' });
    const k = keyOnShard('reopen', 3, 4);
    await db2.set(k, { city: 'gz' });
    const found = await db2.findEq('by-city', 'gz');
    expect(found.map((r) => r.key)).toStrictEqual([k]);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('compact rewrites every shard and preserves data', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    const db = await ClusterDb.open<number>({ dir, shardCount: 4, valueCodec: 'json' });
    const keys = [...keysByShard('cmp', 120, 4).values()].flat();
    // Three generations per key to grow WALs.
    for (let gen = 0; gen < 3; gen++) {
      await db.mset(keys.map((k) => [k, gen] as [string, number]));
    }
    const result = await db.compact();
    expect(result.skipped.length).toBe(0);
    expect([...result.compacted].toSorted((a, b) => a - b)).toStrictEqual([0, 1, 2, 3]);

    const got = await db.mget(keys);
    expect(got.every((v) => v === 2)).toBeTruthy();
    // Still fully writable afterwards.
    await db.set('cmp:after', 99);
    expect(await db.get('cmp:after')).toBe(99);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('findRange applies offset/count/reverse to the globally merged result', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface D {
      n: number;
    }
    const db = await ClusterDb.open<D>({ dir, shardCount: 4, valueCodec: 'json' });
    const byShard = keysByShard('fr', 60, 4);
    expect(byShard.size >= 3).toBeTruthy();
    const entries: [string, D][] = [];
    let i = 0;
    for (const shardKeys of byShard.values()) {
      for (const k of shardKeys) {
        entries.push([k, { n: i % 25 }]); // Values repeat across shards.
        i++;
      }
    }
    await db.mset(entries);
    await db.createIndex('by-n', { field: 'n', type: 'range' });

    // Reference order (field asc, key asc) computed locally from the data.
    const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const rows = entries
      .map(([key, d]) => ({ key, n: d.n }))
      .toSorted((a, b) => a.n - b.n || cmpKey(a.key, b.key));
    const keys = (rs: { key: string }[]) => rs.map((r) => r.key);
    const query = async (opts: Parameters<ClusterDb<D>['findRange']>[1]) =>
      keys(await db.findRange('by-n', opts));

    expect(await query({})).toStrictEqual(keys(rows));
    // Count/offset are global totals, not per shard (4 shards here).
    expect(await query({ count: 6 })).toStrictEqual(keys(rows.slice(0, 6)));
    expect(await query({ offset: 55 })).toStrictEqual(keys(rows.slice(55)));
    expect(await query({ offset: 12, count: 8 })).toStrictEqual(keys(rows.slice(12, 20)));
    // Reverse flips the merged order, including the key tie-break.
    expect(await query({ reverse: true })).toStrictEqual(keys([...rows].toReversed()));
    expect(await query({ reverse: true, count: 7 })).toStrictEqual(keys([...rows].toReversed().slice(0, 7)));
    // Bounds still apply globally on top of offset/count.
    const inBounds = rows.filter((r) => r.n >= 3 && r.n < 20);
    expect(await query({ min: 3, max: 20, maxExclusive: true, count: 5 })).toStrictEqual(keys(inBounds.slice(0, 5)));
    expect(await query({ min: 3, max: 20, maxExclusive: true, offset: 2, count: 5 })).toStrictEqual(keys(inBounds.slice(2, 7)));
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('concurrent createIndex from two instances keeps both registry entries', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface D {
      a: number;
      b: number;
    }
    const shardCount = 4;
    const dbA = await ClusterDb.open<D>({ dir, shardCount, valueCodec: 'json' });
    const dbB = await ClusterDb.open<D>({ dir, shardCount, valueCodec: 'json' });
    // Two different indexes created concurrently: neither registry write may
    // clobber the other.
    await Promise.all([
      dbA.createIndex('ia', { field: 'a' }),
      dbB.createIndex('ib', { field: 'b' }),
    ]);
    await dbA.close();
    await dbB.close();

    // Re-verify through a fresh instance: the registry lists both, and both
    // sidecars answer on every shard.
    const fresh = await ClusterDb.open<D>({ dir, shardCount, valueCodec: 'json' });
    expect((await fresh.listIndexes()).map((d) => d.name).toSorted()).toStrictEqual(['ia', 'ib']);
    for (let id = 0; id < shardCount; id++) {
      const k = keyOnShard('cas', id, shardCount);
      await fresh.set(k, { a: id, b: id + 100 });
      expect((await fresh.findEq('ia', id)).map((r) => r.key)).toStrictEqual([k]);
      expect((await fresh.findEq('ib', id + 100)).map((r) => r.key)).toStrictEqual([k]);
    }
    await fresh.close();
  } finally {
    await rmrf(dir);
  }
});

test('a failed unique createIndex rolls back the shards it already created on', async () => {
  const dir = await tmpDir('minidb-cluster-');
  try {
    interface D {
      u: number;
    }
    const shardCount = 4;
    const db = await ClusterDb.open<D>({ dir, shardCount, valueCodec: 'json' });
    // One u=9 doc per shard plus a second u=9 doc on the LAST shard: the
    // fan-out fails there after the earlier shards already persisted the index.
    for (let id = 0; id < shardCount; id++)
      await db.set(keyOnShard('rb', id, shardCount), { u: 9 });
    await db.set(keyOnShard('rb-dup', shardCount - 1, shardCount), { u: 9 });
    await assert.rejects(
      () => db.createIndex('u-idx', { field: 'u', unique: true }),
      /unique index "u-idx" violation/,
    );
    await db.close();

    // Every shard sidecar must be clean (not just the registry).
    for (let id = 0; id < shardCount; id++) {
      const shard = await MiniDb.open<D>({
        dir: path.join(dir, shardDirName(id, shardCount)),
        valueCodec: 'json',
        readOnly: true,
      });
      expect(shard.listIndexes()).toStrictEqual([]);
      await shard.close();
    }
    const fresh = await ClusterDb.open<D>({ dir, shardCount, valueCodec: 'json' });
    expect(await fresh.listIndexes()).toStrictEqual([]);
    // Writes that the phantom unique index would have rejected now succeed.
    const after = Array.from({ length: shardCount }, (_, id) =>
      keyOnShard('rb-after', id, shardCount),
    );
    for (const k of after) await fresh.set(k, { u: 9 });
    expect((await fresh.mget(after)).map((d) => d?.u)).toStrictEqual(after.map(() => 9));
    await fresh.close();
  } finally {
    await rmrf(dir);
  }
});
