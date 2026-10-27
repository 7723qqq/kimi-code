
import { expect, test } from 'bun:test';

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

    expect(db.query({ limit: 0 }).length, 'sync early path').toBe(0);
    expect(db.query({ limit: 0, sort: { by: 'key', order: 'asc' } }).length, 'sync sorted path').toBe(0);
    expect((await db.queryAsync({ limit: 0 })).length, 'async early path').toBe(0);
    expect(db.scan({ limit: 0 }).length, 'scan').toBe(0);

    expect(db.query({ limit: 1 }).length, 'limit 1 still returns one').toBe(1);
    expect(db.query({ limit: 3 }).length, 'unbounded-ish limit still returns all').toBe(3);

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

    expect(db.query({ dt: { ts: { gte: 100 } }, limit: 0 }).length).toBe(0);
    expect((await db.queryAsync({ dt: { ts: { gte: 100 } }, limit: 0 })).length).toBe(0);
    expect(db.query({ dt: { ts: { gte: 100 } }, limit: 1 }).length).toBe(1);
    expect(db.query({ dt: { ts: { gte: 100 } }, limit: 3 }).length).toBe(3);

    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('L8: size rejects after close, like get/has/scan', async () => {
  const dir = await tmpDir('minidb-l8-');
  try {
    const db = await seededDb(dir);
    expect(db.size, 'size is live while open').toBe(3);
    await db.close();

    expect(() => db.size).toThrow(/MiniDb is closed/);
    expect(() => db.get('a')).toThrow(/MiniDb is closed/);
    expect(() => db.has('a')).toThrow(/MiniDb is closed/);
  } finally {
    await rmrf(dir);
  }
});
