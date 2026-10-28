import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Covers the secondary-index paths not exercised by indexes.test.ts: drop,
// error branches, unique range indexes, and findRange options.
import { expect, test } from 'bun:test';

import { MiniDb, UniqueViolationError } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-idx2-'));
}

test('dropIndex removes the index and reports status', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    expect(db.listIndexes().length).toBe(1);
    expect(await db.dropIndex('byCity')).toBe(true);
    expect(db.listIndexes().length).toBe(0);
    // Dropping a missing index returns false.
    expect(await db.dropIndex('byCity')).toBe(false);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex validates field and duplicate names', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await expect((() => db.createIndex('bad', {} as never))()).rejects.toThrow(/requires a field/);
    await db.createIndex('byCity', { field: 'city' });
    await expect((() => db.createIndex('byCity', { field: 'city' }))()).rejects.toThrow(/already exists/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findEq / findRange reject the wrong index type', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('eq', { field: 'n' });
    await db.createIndex('rg', { field: 'n', type: 'range' });
    await db.set('a', { n: 1 });
    expect(() => db.findEq('rg', 1)).toThrow(/not an equality index/);
    expect(() => db.findRange('eq', {})).toThrow(/not a range index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findRange supports exclusive bounds, offset and reverse', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 5; i++) await db.set(`p${i}`, { age: i * 10 });

    // Exclusive on both ends: (20, 50) => 30, 40.
    expect(db
        .findRange('byAge', { min: 20, max: 50, minExclusive: true, maxExclusive: true })
        .map((r) => r.field)).toStrictEqual([30, 40]);
    // Offset skips the first matches.
    expect(db.findRange('byAge', { offset: 1, count: 2 }).map((r) => r.field)).toStrictEqual([20, 30]);
    // Reverse ordering.
    expect(db.findRange('byAge', { reverse: true, count: 2 }).map((r) => r.field)).toStrictEqual([50, 40]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unique range index rejects duplicate numeric values', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byScore', { field: 'score', type: 'range', unique: true });
    await db.set('a', { score: 10 });
    await expect((() => db.set('b', { score: 10 }))()).rejects.toThrow(UniqueViolationError);
    // Re-setting the same key with the same value is still allowed.
    await db.set('a', { score: 10 });
    expect(db.size).toBe(1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sparse index skips records missing the field', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' }); // sparse by default
    await db.set('a', { city: 'Paris' });
    await db.set('b', { name: 'no-city' });
    expect(db.findEq('byCity', 'Paris').map((r) => r.key)).toStrictEqual(['a']);
    expect(db.size).toBe(2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('secondary indexes require the json codec', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    await expect((() => db.createIndex('x', { field: 'n' }))()).rejects.toThrow(/require valueCodec: "json"/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unique range index: batch swap, del+reuse, and conflict', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byScore', { field: 'score', type: 'range', unique: true });
    await db.set('a', { score: 1 });
    await db.set('b', { score: 2 });

    // Swapping two values inside one batch is a valid final state.
    await db.batch([
      { op: 'set', key: 'a', value: { score: 2 } },
      { op: 'set', key: 'b', value: { score: 1 } },
    ]);
    expect(db.get('a')?.score).toBe(2);
    expect(db.get('b')?.score).toBe(1);

    // Claiming an untouched owner's value is still rejected, batch-atomically.
    await expect(db.batch([{ op: 'set', key: 'c', value: { score: 2 } }])).rejects.toThrow(UniqueViolationError);
    expect(db.get('c'), 'nothing committed on failure').toBe(undefined);

    // Deleting the holder and reusing its value in the same batch is valid.
    await db.batch([
      { op: 'del', key: 'a' },
      { op: 'set', key: 'c', value: { score: 2 } },
    ]);
    expect(db.get('a')).toBe(undefined);
    expect(db.get('c')?.score).toBe(2);

    // Two batch keys claiming the same fresh value is an intra-batch conflict.
    await expect(db.batch([
        { op: 'set', key: 'd', value: { score: 9 } },
        { op: 'set', key: 'e', value: { score: 9 } },
      ])).rejects.toThrow(UniqueViolationError);
    expect(db.get('d')).toBe(undefined);
    expect(db.get('e')).toBe(undefined);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- plan 10: sidecar mutation serialization + staged → persist → publish --

/** White-box handle on a private persist*Definitions method, so a test can
 *  inject a sidecar-write failure at the exact transaction point. Returns a
 *  restore function. */
function stubPersist(
  db: MiniDb,
  key:
    | 'persistIndexDefinitions'
    | 'persistCompoundIndexDefinitions'
    | 'persistTextIndexDefinitions',
  impl: (defs: { name: string }[]) => Promise<void>,
): () => void {
  const priv = db as unknown as Record<typeof key, (defs: { name: string }[]) => Promise<void>>;
  const saved = priv[key];
  priv[key] = impl;
  return () => {
    priv[key] = saved;
  };
}

/** Sidecar definition names, or [] when the file does not exist yet. */
async function sidecarNames(dir: string, file: string): Promise<string[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as { name: string }[])
      .map((d) => d.name)
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('100 concurrent createIndex pairs: zero failures; memory == sidecar == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    // The review #7 repro (100/100 failures before the fix): two concurrent
    // creates shared one fixed .tmp and one renamed the other's tmp away,
    // leaving the rejected index in the memory registry only.
    for (let i = 0; i < 100; i++) {
      const results = await Promise.allSettled([
        db.createIndex(`a${i}`, { field: 'a' }),
        db.createIndex(`b${i}`, { field: 'b' }),
      ]);
      expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status)), `round ${i}`).toStrictEqual(['fulfilled', 'fulfilled']);
    }
    const memory = db
      .listIndexes()
      .map((x) => x.name)
      .toSorted();
    expect(memory.length).toBe(200);
    expect(await sidecarNames(dir, 'db.indexes.json')).toStrictEqual(memory);
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    expect(db
        .listIndexes()
        .map((x) => x.name)
        .toSorted()).toStrictEqual(memory);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex persist failure: no phantom in memory or sidecar, original error rethrown, retry succeeds', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('keep', { field: 'keep' });
    await db.set('k1', { keep: 1, a: 1 });
    const boom = new Error('injected sidecar write failure');
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      throw boom;
    });
    await expect(db.createIndex('byA', { field: 'a' })).rejects.toBe(boom);
    restore();
    // The live registry carries no phantom and the old index keeps serving.
    expect(db.listIndexes().map((x) => x.name)).toStrictEqual(['keep']);
    expect(() => db.findEq('byA', 1)).toThrow(/no such index/);
    expect(db.findEq('keep', 1).map((r) => r.key)).toStrictEqual(['k1']);
    // The sidecar never gained the definition.
    expect(await sidecarNames(dir, 'db.indexes.json')).toStrictEqual(['keep']);
    // Retrying the same create succeeds — no phantom "already exists".
    await db.createIndex('byA', { field: 'a' });
    expect(db.findEq('byA', 1).map((r) => r.key)).toStrictEqual(['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dropIndex persist failure: the live index stays usable and the sidecar is unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('byA', { field: 'a' });
    await db.set('k1', { a: 1 });
    const before = await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8');
    const boom = new Error('injected sidecar write failure');
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      throw boom;
    });
    await expect(db.dropIndex('byA')).rejects.toBe(boom);
    restore();
    // The index is still live and answering queries.
    expect(db.findEq('byA', 1).map((r) => r.key)).toStrictEqual(['k1']);
    // The sidecar is byte-identical (no torn rewrite).
    expect(await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8')).toBe(before);
    // A later successful drop persists fine.
    expect(await db.dropIndex('byA')).toBe(true);
    expect(db.listIndexes()).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex rebuild failure: no phantom, existing indexes keep serving, unique rollback unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('keep', { field: 'keep' });
    await db.set('k1', { keep: 1, a: 1 });
    const boom = new Error('injected rebuild failure');
    const saved = db.indexes.rebuildStaged;
    db.indexes.rebuildStaged = () => {
      throw boom;
    };
    await expect(db.createIndex('byA', { field: 'a' })).rejects.toBe(boom);
    db.indexes.rebuildStaged = saved;
    // No phantom in the registry; the pre-existing index is untouched.
    expect(db.listIndexes().map((x) => x.name)).toStrictEqual(['keep']);
    expect(db.findEq('keep', 1).map((r) => r.key)).toStrictEqual(['k1']);
    // The sidecar was never rewritten.
    expect(await sidecarNames(dir, 'db.indexes.json')).toStrictEqual(['keep']);
    // Unique-violation rollback keeps its semantics: the rejected create
    // leaves nothing behind either.
    await db.set('k2', { keep: 2, u: 'dup' });
    await db.set('k3', { keep: 3, u: 'dup' });
    await expect(db.createIndex('byU', { field: 'u', unique: true })).rejects.toThrow(/unique/i);
    expect(db.listIndexes().map((x) => x.name)).toStrictEqual(['keep']);
    expect(await sidecarNames(dir, 'db.indexes.json')).toStrictEqual(['keep']);
    // And the staged path still recovers: a valid create lands fine.
    await db.createIndex('byA', { field: 'a' });
    expect(db.findEq('byA', 1).map((r) => r.key)).toStrictEqual(['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixed create/drop across the three sidecar types: every op lands serialized; memory == sidecars == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('secOld', { field: 'old' });
    await db.createCompoundIndex('cmpOld', { groupBy: 'ws', orderBy: 'updatedAt' });
    await db.createTextIndex('txtOld', { fields: ['text'] });
    await db.set(
      'd1',
      { old: 1, a: 1, b: 2, ws: 'W', text: 'hello world' },
      { dt: { updatedAt: 100, createdAt: 50 } },
    );

    const ops: (() => Promise<unknown>)[] = [
      () => db.createIndex('secA', { field: 'a' }),
      () => db.createIndex('secB', { field: 'b' }),
      () => db.dropIndex('secOld'),
      () => db.createCompoundIndex('cmpA', { groupBy: 'ws', orderBy: 'createdAt' }),
      () => db.dropCompoundIndex('cmpOld'),
      () => db.createTextIndex('txtA', { fields: ['text'] }),
      () => db.dropTextIndex('txtOld'),
    ];
    const results = await Promise.allSettled(ops.map((op) => op()));
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toStrictEqual(ops.map(() => 'fulfilled'));

    const expectSec = ['secA', 'secB'];
    const expectCmp = ['cmpA'];
    const expectTxt = ['txtA'];
    expect(db
        .listIndexes()
        .map((x) => x.name)
        .toSorted()).toStrictEqual(expectSec);
    expect(db
        .listCompoundIndexes()
        .map((x) => x.name)
        .toSorted()).toStrictEqual(expectCmp);
    expect(db.search('txtA', 'hello').map((r) => r.key)).toStrictEqual(['d1']);
    expect(() => db.search('txtOld', 'hello')).toThrow(/no such text index/);
    // The staged rebuild also caught the pre-existing document.
    expect(db.findEq('secA', 1).map((r) => r.key)).toStrictEqual(['d1']);
    expect(db.compoundRange('cmpA', 'W').map((r) => r.key)).toStrictEqual(['d1']);

    expect(await sidecarNames(dir, 'db.indexes.json')).toStrictEqual(expectSec);
    expect(await sidecarNames(dir, 'db.compound-indexes.json')).toStrictEqual(expectCmp);
    expect(await sidecarNames(dir, 'db.textindexes.json')).toStrictEqual(expectTxt);

    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    expect(db
        .listIndexes()
        .map((x) => x.name)
        .toSorted()).toStrictEqual(expectSec);
    expect(db
        .listCompoundIndexes()
        .map((x) => x.name)
        .toSorted()).toStrictEqual(expectCmp);
    expect(db.search('txtA', 'hello').map((r) => r.key)).toStrictEqual(['d1']);
    expect(() => db.search('txtOld', 'hello')).toThrow(/no such text index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('set/batch/del do not share the sidecar mutation chain (writes flow while a create is parked)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      entered();
      await gate;
    });
    const create = db.createIndex('byA', { field: 'a' });
    // The create now holds the secondary chain inside its persist.
    await inPersist;
    // Writes must flow regardless — the data path never touches that chain.
    for (let i = 0; i < 50; i++) await db.set(`k${i}`, { a: i });
    await db.batch([
      { op: 'set', key: 'b1', value: { a: 100 } },
      { op: 'del', key: 'k0' },
    ]);
    expect(db.size).toBe(50);
    release();
    await create;
    restore();
    // The create completed, published, and (thanks to the staged index being
    // fed by the write path during its persist window) reflects every write
    // that landed while it was parked.
    expect(db.listIndexes().map((x) => x.name)).toStrictEqual(['byA']);
    expect(db.findEq('byA', 100).map((r) => r.key)).toStrictEqual(['b1']);
    expect(db.findEq('byA', 0).length, 'k0 was deleted before publish').toBe(0);
    expect(db.findEq('byA', 49).map((r) => r.key)).toStrictEqual(['k49']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('open cleans up unique-suffixed sidecar tmp leftovers (but never a lock tmp)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.close();
  // A crash between writeFileAtomic's tmp write and its rename orphans this.
  const orphan = path.join(dir, 'db.indexes.json.tmp-99999-1');
  await fs.writeFile(orphan, 'partial{');
  // A LockFile tmp is another component's in-flight file: never matched.
  const lockTmp = path.join(dir, 'db.lock.tmp-99999-1');
  await fs.writeFile(lockTmp, 'lock');
  const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
  await expect(fs.stat(orphan)).rejects.toThrow(/ENOENT/);
  await fs.stat(lockTmp); // untouched
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a staged unique index constrains writes during its persist window', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('k1', { u: 'taken' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      entered();
      await gate;
    });
    const create = db.createIndex('byU', { field: 'u', unique: true });
    // The create is parked inside its persist; the staged unique index is
    // fully built and must already be enforced, or a write in this window
    // could break the constraint the publish is about to enforce.
    await inPersist;
    await expect(db.set('k2', { u: 'taken' })).rejects.toThrow(UniqueViolationError);
    await expect(db.batch([{ op: 'set', key: 'k4', value: { u: 'taken' } }])).rejects.toThrow(UniqueViolationError);
    // A conforming write lands and is reflected by the index once published.
    await db.set('k3', { u: 'free' });
    release();
    await create;
    restore();
    expect(db.findEq('byU', 'free').map((r) => r.key)).toStrictEqual(['k3']);
    // The rejected writes can proceed with non-conflicting values.
    await db.set('k2', { u: 'taken2' });
    expect(db.findEq('byU', 'taken2').map((r) => r.key)).toStrictEqual(['k2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 11: canonical value — one representation for every view --------

test('toJSON/getter/Proxy docs: get, secondary/compound/text indexes and unique checks all see the persisted view (and reopen agrees)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createIndex('byV', { field: 'v' });
    await db.createIndex('byW', { field: 'w' });
    await db.createIndex('byU', { field: 'u', unique: true });
    await db.createCompoundIndex('byG', { groupBy: 'g', orderBy: 'o' });
    await db.createTextIndex('ft', { fields: ['t'] });

    // A getter whose value CHANGES per read: encode sees 'v-1'; before stage
    // 11 the secondary index re-read the getter and indexed 'v-2' — the live
    // index and the store (and every reopen) disagreed.
    let reads = 0;
    const getterDoc: Record<string, unknown> = { u: 'u1', g: 'G', o: 5, t: 'alpha bravo' };
    Object.defineProperty(getterDoc, 'v', {
      enumerable: true,
      get: () => `v-${++reads}`,
    });
    await db.set('k1', getterDoc);
    expect(reads, 'the getter is consumed exactly once (at encode)').toBe(1);

    // toJSON replaces the persisted shape entirely.
    const toJsonDoc = {
      u: 'u2',
      w: 'raw-w',
      t: 'hidden',
      toJSON: () => ({ u: 'u2', w: 'json-w' }),
    };
    await db.set('k2', toJsonDoc as unknown as Record<string, unknown>);

    // A Proxy is transparently persisted as the plain object it wraps.
    const proxyDoc = new Proxy({ u: 'u3', w: 'pw', t: 'proxied term' }, {});
    await db.set('k3', proxyDoc);

    const assertViews = (label: string, db: MiniDb) => {
      // get(): the decoded stored bytes.
      expect((db.get('k1') as { v: string }).v, `${label}: get returns the persisted getter value`).toBe('v-1');
      expect(db.get('k2'), `${label}: get returns the toJSON shape`).toStrictEqual({ u: 'u2', w: 'json-w' });
      expect(db.get('k3'), `${label}: get returns the Proxy target shape`).toStrictEqual({ u: 'u3', w: 'pw', t: 'proxied term' });
      // Secondary indexes: the persisted values, never a second getter read.
      expect(db.findEq('byV', 'v-1').map((r) => r.key), `${label}: index has the persisted value`).toStrictEqual(['k1']);
      expect(db.findEq('byV', 'v-2'), `${label}: the never-persisted second getter read is NOT indexed`).toStrictEqual([]);
      expect(db.findEq('byW', 'json-w').map((r) => r.key)).toStrictEqual(['k2']);
      expect(db.findEq('byW', 'raw-w'), `${label}: the raw (unpersisted) toJSON field is NOT indexed`).toStrictEqual([]);
      expect(db.findEq('byW', 'pw').map((r) => r.key)).toStrictEqual(['k3']);
      // Compound index.
      expect(db.compoundRange('byG', 'G').map((r) => r.key), `${label}: compound index view`).toStrictEqual(['k1']);
      // Text index: toJSON dropped 't' from k2, so only k1/k3 have text.
      expect(db.search('ft', 'alpha').map((r) => r.key), `${label}: text index view`).toStrictEqual(['k1']);
      expect(db.search('ft', 'hidden'), `${label}: text the toJSON hid is NOT indexed`).toStrictEqual([]);
      expect(db.search('ft', 'proxied').map((r) => r.key)).toStrictEqual(['k3']);
    };
    assertViews('live', db);

    // Unique checks consume the canonical view too: a conflicting plain doc
    // is rejected against the value the getter/toJSON/Proxy actually stored.
    await expect(db.set('k4', { u: 'u1' })).rejects.toThrow(UniqueViolationError);
    await expect(db.batch([{ op: 'set', key: 'k5', value: { u: 'u3' } }])).rejects.toThrow(UniqueViolationError);
    // And re-setting k1 (holder = same key) stays legal despite the getter.
    await db.set('k1', getterDoc);
    expect((db.get('k1') as { v: string }).v, 're-set re-encodes (one more getter read)').toBe('v-2');

    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    // The reopened index views are rebuilt from the persisted bytes — they
    // must be identical to the live views (v-2 now, after the re-set).
    expect(db.findEq('byV', 'v-2').map((r) => r.key), 'reopen: same persisted view').toStrictEqual(['k1']);
    expect((db.get('k1') as { v: string }).v).toBe('v-2');
    expect(db.get('k2')).toStrictEqual({ u: 'u2', w: 'json-w' });
    expect(db.findEq('byW', 'json-w').map((r) => r.key)).toStrictEqual(['k2']);
    expect(db.compoundRange('byG', 'G').map((r) => r.key)).toStrictEqual(['k1']);
    expect(db.search('ft', 'alpha').map((r) => r.key)).toStrictEqual(['k1']);
    expect(db.search('ft', 'proxied').map((r) => r.key)).toStrictEqual(['k3']);
    await expect(db.set('k6', { u: 'u1' })).rejects.toThrow(UniqueViolationError);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
