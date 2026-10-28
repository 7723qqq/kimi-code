import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/compaction.test.ts
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';
import { waitFor } from './helpers.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-compact-'));
}

test('manual compact writes a snapshot, shrinks the WAL, and keeps data', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 500; i++) await db.set(`k${i}`, `value-${i}`);
    const walBefore = (await fs.stat(path.join(dir, 'db.wal'))).size;
    await db.compact();
    expect(db.stats.compactions).toBe(1);

    const snap = await fs.stat(path.join(dir, 'db.snapshot'));
    const walAfter = (await fs.stat(path.join(dir, 'db.wal'))).size;
    expect(snap.size > 0, 'snapshot file exists and is non-empty').toBeTruthy();
    expect(walAfter < walBefore, 'WAL shrank after compaction').toBeTruthy();
    expect(db.size).toBe(500);
    await db.close();

    // Recovery should load snapshot + (small) WAL and restore everything.
    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.recoveryInfo.snapshotFrames).toBe(500);
    expect(db.size).toBe(500);
    expect(db.get('k0')).toBe('value-0');
    expect(db.get('k499')).toBe('value-499');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a write issued during compaction is preserved', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, `v${i}`);

    const compactP = db.compact();
    const setP = db.set('during', 'hello'); // guard should queue behind compaction
    await Promise.all([compactP, setP]);

    expect(db.get('during')).toBe('hello');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.size).toBe(201);
    expect(db.get('during')).toBe('hello');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('auto-compaction triggers when the WAL crosses the threshold', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1024, // 1 KiB
    });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, `v${i}`.padEnd(50, 'x'));
    // Allow the background compaction to finish (stage 6: it is queued on
    // the maintenance scheduler, so poll rather than reading db.compacting
    // synchronously).
    await waitFor(() => db.stats.compactions >= 1, 'auto-compaction to complete');
    expect(db.size).toBe(200);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('open-time compaction runs in the background — open() returns with the full dataset', async () => {
  const dir = await tmpDir();
  try {
    // Grow the WAL well past the threshold without any compaction.
    let db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, `v${i}`.padEnd(50, 'x'));
    await db.close();

    // Reopen with a 1 KiB threshold: the WAL far exceeds it, so compaction
    // fires — but open() must NOT block on the rewrite. The recovered store
    // is already complete and consistent the moment open() resolves.
    db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1024,
    });
    expect(db.size).toBe(200);
    for (let i = 0; i < 200; i++) expect(db.get(`k${i}`)).toBe(`v${i}`.padEnd(50, 'x'));

    // The background compaction finishes on its own and shrinks the WAL
    // (stage 6: queued on the maintenance scheduler — poll for completion).
    await waitFor(() => db.stats.compactions >= 1, 'open-time background compaction');
    if (db.compacting) await db._compactDone;
    expect((await fs.stat(path.join(dir, 'db.wal'))).size < 1024, 'WAL shrank').toBeTruthy();
    expect(db.size).toBe(200);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('del-then-compact drops tombstoned keys from the snapshot', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    await db.set('b', '2');
    await db.del('a');
    await db.compact();
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.recoveryInfo.snapshotFrames).toBe(1); // only 'b' survived
    expect(db.get('a')).toBe(undefined);
    expect(db.get('b')).toBe('2');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  'concurrent SET/UPDATE/DEL during compaction survive recovery',
  { timeout: 30_000 },
  async () => {
    // Exercises the fuzzy-snapshot + WAL-tail-replay convergence: writes that
    // land while the snapshot is being written must all be reflected after a
    // reopen, with last-writer-wins semantics.
    const dir = await tmpDir();
    try {
      let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
      // 5000 keys span 2 writeSnapshot yield windows (yieldEvery=2000, src/snapshot.ts),
      // so the ops below genuinely race an in-progress snapshot.
      const N = 5000;
      for (let base = 0; base < N; base += 500) {
        await db.batch(
          Array.from({ length: Math.min(500, N - base) }, (_, j) => ({
            op: 'set' as const,
            key: 'k' + (base + j),
            value: 'v' + (base + j),
          })),
        );
      }

      // Even keys are updated, keys == 1 (mod 4) are deleted, keys == 3 (mod 4)
      // are left untouched, and a batch of new keys is added — all racing the
      // in-progress snapshot.
      let deleted = 0;
      const M = 1000;
      const compactP = db.compact();
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) ops.push(db.set('k' + i, 'updated-' + i));
        else if (i % 4 === 1) {
          deleted++;
          ops.push(db.del('k' + i));
        }
      }
      for (let i = 0; i < M; i++) ops.push(db.set('new' + i, 'n' + i));
      await Promise.all(ops);
      await compactP;
      await db.close();

      db = await MiniDb.open({ dir, valueCodec: 'string' });
      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) expect(db.get('k' + i), `updated k${i}`).toBe('updated-' + i);
        else if (i % 4 === 1) expect(db.get('k' + i), `deleted k${i}`).toBe(undefined);
        else expect(db.get('k' + i), `unchanged k${i}`).toBe('v' + i);
      }
      for (let i = 0; i < M; i++) expect(db.get('new' + i), `new${i}`).toBe('n' + i);
      expect(db.size).toBe(N - deleted + M);
      await db.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('compaction with no concurrent writes produces an empty WAL tail', async () => {
  // When nothing is written during compaction, the post-fence WAL tail is empty
  // and the new WAL should be zero-length (or near-zero). Data still survives.
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 300; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    expect(walSize, 'WAL tail is empty when no writes raced compaction').toBe(0);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.size).toBe(300);
    expect(db.get('k0')).toBe('v0');
    expect(db.get('k299')).toBe('v299');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disk-mode compaction with continuous writes stays consistent for sync and async readers', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      valueMode: 'disk',
      compactThresholdBytes: 16 * 1024,
      fsyncPolicy: 'no',
    });
    // Seed past the threshold, then compact while writes continue: the
    // stage-6 grouped async snapshot reads must produce the same snapshot a
    // synchronous reader would.
    for (let i = 0; i < 300; i++)
      await db.set(`k${i}`, { n: i, text: `bulk ${i} ${'x'.repeat(40)}` });
    const compactP = db.compact();
    for (let i = 300; i < 380; i++) await db.set(`k${i}`, { n: i, text: `tail ${i}` });
    await compactP;
    expect(db.size).toBe(380);
    for (let i = 0; i < 380; i += 13) {
      expect(await db.getAsync(`k${i}`)).toStrictEqual(db.get(`k${i}`));
    }
    await db.close();

    // A read-only reader recovers the rotated pair and agrees.
    const ro = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      valueMode: 'disk',
      readOnly: true,
    });
    expect(ro.size).toBe(380);
    for (let i = 0; i < 380; i += 17) {
      expect(await ro.getAsync(`k${i}`)).toStrictEqual(ro.get(`k${i}`));
      expect(ro.get(`k${i}`)!.n).toBe(i);
    }
    await ro.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
