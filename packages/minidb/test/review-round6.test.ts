import assert from 'node:assert/strict';

import { test } from 'vitest';

import { MiniDb } from '../src/index.js';
import { rmrf, tmpDir } from './helpers.js';

// Regression tests for the second-round code review:
//   L6) limit:0 must return zero rows on every query path (sync early, sync
//       dt fast path, async early, async dt fast path) — not one.
//   L8) size after close() must reject like every other accessor, instead of
//       reporting the last in-memory count of a closed database.

async function seededDb(dir: string): Promise<MiniDb<string>> {
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  await db.set('b', '2');
  await db.set('c', '3');
  return db;
}

test('L6: query({limit:0}) returns zero rows on every path', async () => {
  const dir = await tmpDir('minidb-l6-');
  try {
    const db = await seededDb(dir);

    assert.equal((await db.query({ limit: 0 })).length, 0, 'sync early path');
    assert.equal(
      (await db.query({ limit: 0, sort: { by: 'key', order: 'asc' } })).length,
      0,
      'sync sorted path',
    );
    assert.equal((await db.queryAsync({ limit: 0 })).length, 0, 'async early path');
    assert.equal((await db.scan({ limit: 0 })).length, 0, 'scan');

    assert.equal((await db.query({ limit: 1 })).length, 1, 'limit 1 still returns one');
    assert.equal((await db.query({ limit: 3 })).length, 3, 'unbounded-ish limit still returns all');

    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('L6: dt fast path honours limit:0', async () => {
  const dir = await tmpDir('minidb-l6dt-');
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('a', { role: 'user', n: 1 }, { dt: { ts: 100 } });
    await db.set('b', { role: 'user', n: 2 }, { dt: { ts: 200 } });
    await db.set('c', { role: 'user', n: 3 }, { dt: { ts: 300 } });

    assert.equal((await db.query({ dt: { ts: { gte: 100 } }, limit: 0 })).length, 0);
    assert.equal((await db.queryAsync({ dt: { ts: { gte: 100 } }, limit: 0 })).length, 0);
    assert.equal((await db.query({ dt: { ts: { gte: 100 } }, limit: 1 })).length, 1);
    assert.equal((await db.query({ dt: { ts: { gte: 100 } }, limit: 3 })).length, 3);

    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('L8: size rejects after close, like get/has/scan', async () => {
  const dir = await tmpDir('minidb-l8-');
  try {
    const db = await seededDb(dir);
    assert.equal(db.size, 3, 'size is live while open');
    await db.close();

    assert.throws(() => db.size, /MiniDb is closed/);
    assert.throws(() => db.get('a'), /MiniDb is closed/);
    assert.throws(() => db.has('a'), /MiniDb is closed/);
  } finally {
    await rmrf(dir);
  }
});
