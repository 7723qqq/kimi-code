import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/db.test.ts
import { expect, test } from 'bun:test';

import { encodeFrame, TYPE_SET } from '../src/codec.js';
import { MiniDb } from '../src/index.js';
import { barrier, waitFor } from './helpers.js';

const B = (s) => Buffer.from(s);

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-db-'));
}

test('set/get persists across reopen (string codec)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec' });
    await db.set('a', '1');
    await db.set('b', '2');
    expect(db.get('a')).toBe('1');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.get('a')).toBe('1');
    expect(db.get('b')).toBe('2');
    expect(db.size).toBe(2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('del persists across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('x', '1');
    await db.set('y', '2');
    await db.del('x');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.get('x')).toBe(undefined);
    expect(db.get('y')).toBe('2');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json codec round-trips values', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('obj', { a: 1, b: [2, 3] });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    expect(db.get('obj')).toStrictEqual({ a: 1, b: [2, 3] });
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ttl / expire', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    await db.set('t', 'v', { ttl: 50 });
    expect(db.ttl('t') > 0 && db.ttl('t') <= 50).toBeTruthy();
    expect(db.ttl('nope')).toBe(-2);
    await db.expire('t', 1000);
    expect(db.ttl('t') > 50).toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery truncates a torn WAL tail and keeps valid data', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, `v${i}`);
    await db.close();

    // Append a half-written frame to simulate a crash mid-write.
    const walPath = path.join(dir, 'db.wal');
    const partial = encodeFrame({
      type: TYPE_SET,
      key: B('torn'),
      value: B('x'.repeat(200)),
    }).subarray(0, 11);
    await fs.appendFile(walPath, partial);

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.recoveryInfo.truncatedWal).toBe(true);
    expect(db.size).toBe(100);
    expect(db.get('k0')).toBe('v0');
    expect(db.get('k99')).toBe('v99');
    await db.close();

    // The torn tail is gone for good.
    const reopened = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(reopened.recoveryInfo.truncatedWal).toBe(false);
    expect(reopened.size).toBe(100);
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maxMemory reject policy blocks writes over budget', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      maxMemoryBytes: 50,
      maxMemoryPolicy: 'reject',
    });
    await db.set('a', '1234567890');
    await db.set('b', '1234567890');
    await db.set('c', '1234567890');
    await db.set('d', '1234567890');
    await assert.rejects(() => db.set('e', '1234567890'), /maxMemory exceeded/);
    expect(db.get('e')).toBe(undefined);
    expect(db.stats.maxMemoryRejections >= 1).toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maxMemory evict-lru evicts old keys to make room', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      maxMemoryBytes: 50,
      maxMemoryPolicy: 'evict-lru',
    });
    await db.set('a', '1234567890');
    await db.set('b', '1234567890');
    await db.set('c', '1234567890');
    await db.set('d', '1234567890');
    expect(db.get('a')).toBe('1234567890'); // touch a; b becomes the LRU victim
    await db.set('e', '1234567890');
    expect(db.get('a')).toBe('1234567890');
    expect(db.get('b')).toBe(undefined);
    expect(db.get('e')).toBe('1234567890');
    expect(db.stats.evictions >= 1).toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('backup + restore preserves data, indexes, and text search', async () => {
  const dir = await tmpDir();
  const backupDir = await tmpDir();
  const restoreDir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.createTextIndex('body', { fields: ['body'] });
    await db.set('a', { city: 'Paris', body: 'hello world' });
    await db.set('b', { city: 'London', body: 'hello London' });
    await db.backup(backupDir);
    await db.close();

    const restored = await MiniDb.restore(backupDir, restoreDir, { valueCodec: 'json' });
    expect(restored.get('a')).toStrictEqual({ city: 'Paris', body: 'hello world' });
    expect(restored.findEq('byCity', 'London').map((r) => r.key)).toStrictEqual(['b']);
    expect(restored
        .search('body', 'hello')
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b']);
    await restored.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.rm(restoreDir, { recursive: true, force: true });
  }
});

test('backup fences writes at a linearization point: every pre-fence ack is in, concurrent writes reject (review #22)', async () => {
  const dir = await tmpDir();
  const parent = await tmpDir();
  const backupDir = path.join(parent, 'backup-dest'); // intentionally absent
  const restoreDir = await tmpDir();
  try {
    const db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    await db.set('seed1', 'a');
    await db.set('seed2', 'b');

    // Park the WAL writev of the NEXT write so a set is provably in flight
    // when the backup starts: the backup's drain must wait for it, and its
    // ack then lands INSIDE the backup (it entered before the fence).
    const fh = (db as unknown as { wal: { fh: { writev: (...a: unknown[]) => Promise<unknown> } } })
      .wal.fh;
    const gate = barrier(fh, 'writev', 1);
    const inFlight = db.set('inflight', 'c');
    await gate.entered;

    const backingUp = db.backup(backupDir, { compact: false });
    let backupDone = false;
    void backingUp.then(() => {
      backupDone = true;
    });

    // Writes submitted behind the fence reject with a clear, retryable error.
    await assert.rejects(
      db.set('late', 'd'),
      (e: unknown) => (e as { code?: string }).code === 'BACKUP_IN_PROGRESS',
    );
    await assert.rejects(
      db.batch([{ op: 'set', key: 'late2', value: 'd' }]),
      /backup is in progress/i,
    );
    // The backup cannot complete while the fenced-in write is still parked.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(backupDone, 'backup waits for the in-flight write (its linearization point)').toBe(false);

    gate.release();
    gate.restore();
    await inFlight;
    await backingUp;
    expect(backupDone).toBe(true);

    // After the backup the gate is lifted: writes work again.
    await db.set('after', 'e');
    expect(db.get('after')).toBe('e');
    await db.close();

    // The manifest is the commit marker and lists the copied files.
    const manifest = JSON.parse(
      await fs.readFile(path.join(backupDir, 'backup.manifest.json'), 'utf8'),
    ) as { files: string[] };
    expect(manifest.files.includes('db.wal'), 'manifest lists the WAL').toBeTruthy();

    // Restore: every write ack'd before the fence is in; the rejected ones are not.
    const restored = await MiniDb.restore<string>(backupDir, restoreDir, { valueCodec: 'string' });
    expect(restored.get('seed1')).toBe('a');
    expect(restored.get('seed2')).toBe('b');
    expect(restored.get('inflight'), 'the write drained before the fence is included').toBe('c');
    expect(restored.get('late')).toBe(undefined);
    expect(restored.get('late2')).toBe(undefined);
    expect(restored.get('after'), 'a post-backup write is not included').toBe(undefined);
    await restored.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(restoreDir, { recursive: true, force: true });
  }
});

test('backup copy failure leaves no partial backup behind and reopens the write gate (review #22)', async () => {
  const dir = await tmpDir();
  const parent = await tmpDir();
  const backupDir = path.join(parent, 'backup-dest');
  try {
    const db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    await db.set('k', 'v');

    // Fail the copy phase: every fs.copyFile rejects.
    const boom = new Error('injected copy failure');
    const origCopy = fs.copyFile;
    (fs as unknown as { copyFile: unknown }).copyFile = () => Promise.reject(boom);
    try {
      await assert.rejects(db.backup(backupDir, { compact: false }), /injected copy failure/);
    } finally {
      (fs as unknown as { copyFile: unknown }).copyFile = origCopy;
    }

    // No half backup: the destination was never created, and no temp/aside
    // dir is stranded next to it.
    expect(await fs.stat(backupDir).then(
        () => true,
        () => false,
      ), 'destination untouched').toBe(false);
    const leftovers = (await fs.readdir(parent)).filter((n) => n.includes('.backup-'));
    expect(leftovers, `stranded temp dirs: ${leftovers.join(', ')}`).toStrictEqual([]);

    // The write gate was released: the db keeps working.
    await db.set('after', 'w');
    expect(db.get('after')).toBe('w');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('readOnly open of a non-existent directory fails with ENOENT and creates nothing (review #26)', async () => {
  const parent = await tmpDir();
  const dir = path.join(parent, 'missing');
  try {
    await assert.rejects(
      MiniDb.open({ dir, valueCodec: 'string', readOnly: true }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT',
    );
    expect(await fs.stat(dir).then(
        () => true,
        () => false,
      ), 'no directory was created').toBe(false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('valueMode disk stores value pointers and reads from WAL', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    const big = 'x'.repeat(1000);
    await db.set('a', big);
    const rec = db.store.map.get('a');
    expect(rec?.ref.kind).toBe('disk');
    expect(rec?.ref.kind === 'disk' && rec.ref.loc.file).toBe('wal');
    expect(db.get('a')).toBe(big);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    const rec2 = db.store.map.get('a');
    expect(rec2?.ref.kind).toBe('disk');
    expect(db.get('a')).toBe(big);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk batch stores value pointers and survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    await db.batch([
      { op: 'set', key: 'a', value: '1'.repeat(100) },
      { op: 'set', key: 'b', value: '2'.repeat(100) },
    ]);
    expect(db.store.map.get('a')?.ref.kind).toBe('disk');
    expect(db.store.map.get('b')?.ref.kind).toBe('disk');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    expect(db.get('a')).toBe('1'.repeat(100));
    expect(db.get('b')).toBe('2'.repeat(100));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk compaction remaps pointers to the snapshot', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    await db.set('a', '1'.repeat(1000));
    await db.set('b', '2'.repeat(1000));
    await db.compact();
    const rec = db.store.map.get('a');
    expect(rec?.ref.kind).toBe('disk');
    expect(rec?.ref.kind === 'disk' && rec.ref.loc.file).toBe('snapshot');
    expect(db.get('a')).toBe('1'.repeat(1000));
    expect(db.get('b')).toBe('2'.repeat(1000));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    expect(db.get('a')).toBe('1'.repeat(1000));
    expect(db.get('b')).toBe('2'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk maxMemory excludes value bulk', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      maxMemoryBytes: 200,
      maxMemoryPolicy: 'reject',
      fsyncPolicy: 'no',
    });
    await db.set('a', 'x'.repeat(1000));
    await db.set('b', 'y'.repeat(1000));
    await db.set('c', 'z'.repeat(1000));
    expect(db.get('a')).toBe('x'.repeat(1000));
    expect(db.store.bytes < 200).toBeTruthy();
    await assert.rejects(() => db.set('d', 'w'.repeat(1000)), /maxMemory exceeded/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto selects disk when persisted files exceed maxMemoryBytes', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'auto',
      maxMemoryBytes: Math.max(1, walSize - 1),
      fsyncPolicy: 'no',
    });
    expect(db.valueMode).toBe('disk');
    expect(db.store.map.get('a')?.ref.kind).toBe('disk');
    expect(db.get('a')).toBe('x'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto selects memory when persisted files fit maxMemoryBytes', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'auto',
      maxMemoryBytes: walSize + 1000,
      fsyncPolicy: 'no',
    });
    expect(db.valueMode).toBe('memory');
    expect(db.store.map.get('a')?.ref.kind).toBe('memory');
    expect(db.get('a')).toBe('x'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto without maxMemoryBytes defaults to memory', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'auto', fsyncPolicy: 'no' });
    expect(db.valueMode).toBe('memory');
    expect(db.store.map.get('a')?.ref.kind).toBe('memory');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild preserves data when only a sidecar definition file is corrupt', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<Record<string, number>>({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
    });
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, { n: i });
    await db.createIndex('byN', { field: 'n' });
    await db.close();
    await fs.writeFile(path.join(dir, 'db.indexes.json'), 'corrupt{{{');
    // plain open still throws on the corrupt sidecar...
    await assert.rejects(MiniDb.open({ dir, valueCodec: 'json' }), SyntaxError);
    // ...but openOrRebuild drops the derived sidecars instead of wiping the data
    db = await MiniDb.openOrRebuild<Record<string, number>>({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
    });
    expect(db.size).toBe(100);
    expect(db.get('k42')).toStrictEqual({ n: 42 });
    expect(db.listIndexes()).toStrictEqual([]); // definitions are lost, not the data; recreate as needed
    await db.createIndex('byN2', { field: 'n' });
    expect(db.findEq('byN2', 42).length).toBe(1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('open removes stale compaction temp files', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    await db.close();
    await fs.writeFile(path.join(dir, 'db.snapshot.tmp'), 'stale');
    await fs.writeFile(path.join(dir, 'db.wal.tmp'), 'stale');
    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.get('a')).toBe('1');
    await assert.rejects(fs.stat(path.join(dir, 'db.snapshot.tmp')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(dir, 'db.wal.tmp')), /ENOENT/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('query with skip/limit returns the same rows as slicing the unbounded result', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open<Record<string, number>>({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
    });
    for (let i = 0; i < 200; i++)
      await db.set(`k${String(i).padStart(3, '0')}`, { n: i, grp: i % 4 });
    await db.createIndex('byGrp', { field: 'grp' });
    const full = db.query({ key: { prefix: 'k1' } });
    expect(db.query({ key: { prefix: 'k1' }, limit: 10 })).toStrictEqual(full.slice(0, 10));
    expect(db.query({ key: { prefix: 'k1' }, skip: 5, limit: 3 })).toStrictEqual(full.slice(5, 8));
    const eq = db.query({ filter: { grp: 2 } }); // indexed equality path
    expect(db.query({ filter: { grp: 2 }, limit: 7 })).toStrictEqual(eq.slice(0, 7));
    const scan = db.query({ filter: { n: { $gte: 100 } } }); // unindexed full scan path
    expect(db.query({ filter: { n: { $gte: 100 } }, skip: 10, limit: 5 })).toStrictEqual(scan.slice(10, 15));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maxMemory evict-lru evicts in least-recently-used order across many victims', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      maxMemoryBytes: 50,
      maxMemoryPolicy: 'evict-lru',
    });
    await db.set('a', '1234567890'); // ~11B per record, budget fits 4
    await db.set('b', '1234567890');
    await db.set('c', '1234567890');
    await db.set('d', '1234567890');
    expect(db.get('a')).toBe('1234567890'); // touch a: b becomes LRU
    await db.set('e', '1234567890'); // exceeds budget -> evicts b
    await db.set('f', '1234567890'); // exceeds budget -> evicts c
    expect(db.get('a')).toBe('1234567890');
    expect(db.get('b')).toBe(undefined);
    expect(db.get('c')).toBe(undefined);
    expect(db.get('d')).toBe('1234567890');
    expect(db.get('e')).toBe('1234567890');
    expect(db.get('f')).toBe('1234567890');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 6: async read APIs -------------------------------------------------

for (const valueMode of ['memory', 'disk'] as const) {
  test(`async reads match sync reads (valueMode: ${valueMode})`, async () => {
    const dir = await tmpDir();
    try {
      const db = await MiniDb.open<Record<string, unknown>>({
        dir,
        valueCodec: 'json',
        valueMode,
        autoCompact: false,
      });
      await db.createTextIndex('ft', { fields: ['text'] });
      await db.createIndex('byKind', { field: 'kind' });
      for (let i = 0; i < 300; i++) {
        await db.set(
          `k${i}`,
          { kind: `t${i % 5}`, score: i, text: `hello world doc ${i} 异步 读取 ${i % 7}` },
          { dt: { ts: 1700000000000 + i } },
        );
      }
      await db.del('k0');
      await db.set('k1', { kind: 't1', score: 999, text: 'replaced 替换' });

      // getAsync vs get
      expect(await db.getAsync('k1')).toStrictEqual(db.get('k1'));
      expect(await db.getAsync('k42')).toStrictEqual(db.get('k42'));
      expect(await db.getAsync('k0')).toBe(undefined);
      expect(await db.getAsync('missing')).toBe(undefined);

      // searchBoundedAsync / searchAsync vs search
      for (const q of ['hello', '异步', 'hello world', 'replaced']) {
        const syncRes = db.searchBounded('ft', q, { limit: 20 });
        const asyncRes = await db.searchBoundedAsync('ft', q, { limit: 20 });
        expect(asyncRes, `searchBoundedAsync(${q})`).toStrictEqual(syncRes);
        expect(await db.searchAsync('ft', q, { limit: 20 })).toStrictEqual(db.search('ft', q, { limit: 20 }));
      }

      // queryAsync vs query across the planner's shapes
      const shapes = [
        { filter: { kind: 't3' } },
        { dt: { ts: { gte: 1700000000050 } }, limit: 10 },
        { dt: { ts: { gte: 1700000000050 } }, sort: { ts: -1 as const }, limit: 5 },
        { text: { index: 'ft', q: 'hello' }, limit: 10 },
        { key: { prefix: 'k1' }, limit: 5 },
        { sort: { score: -1 as const }, limit: 7 },
        { filter: { kind: 't2' }, sort: { score: 1 as const }, skip: 3, limit: 6 },
      ];
      for (const q of shapes) {
        expect(await db.queryAsync(q), `queryAsync(${JSON.stringify(q)})`).toStrictEqual(db.query(q));
      }
      await db.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('async reads stay correct across a compaction rotation (disk mode)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      valueMode: 'disk',
      compactThresholdBytes: 4096,
    });
    for (let i = 0; i < 400; i++) {
      await db.set(`k${i}`, { kind: `t${i % 5}`, score: i, text: `rotation doc ${i}` });
    }
    await waitFor(() => db.stats.compactions >= 1, 'auto compaction');
    for (let i = 400; i < 500; i++) {
      await db.set(`k${i}`, { kind: 't6', score: i, text: `post rotation doc ${i}` });
    }
    for (let i = 0; i < 500; i += 37) {
      expect(await db.getAsync(`k${i}`)).toStrictEqual(db.get(`k${i}`));
    }
    await db.close();
    // read-only reopen: async reads identical to sync reads against the rotated files.
    const ro = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      valueMode: 'disk',
      readOnly: true,
    });
    for (let i = 0; i < 500; i += 41) {
      expect(await ro.getAsync(`k${i}`)).toStrictEqual(ro.get(`k${i}`));
    }
    await ro.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
