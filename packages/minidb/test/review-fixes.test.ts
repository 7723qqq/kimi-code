import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Regression tests for the deep-review fixes.
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';
import { WAL } from '../src/wal.js';
import { barrier } from './helpers.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-fix-'));
}

// --- P0: WAL.flush() must drain frames queued behind an in-flight batch -----

test('WAL.flush() drains frames queued behind an in-flight batch', async () => {
  const dir = await tmpDir();
  try {
    const wal = new WAL(path.join(dir, 'a.wal'), { fsyncPolicy: 'always' });
    await wal.open();
    // Deterministic barrier instead of the old two-setImmediate guess (review
    // #28): the first writev parks, so batch A is PROVABLY in flight when B
    // is appended behind it.
    const fh = (wal as unknown as { fh: { writev: (...a: unknown[]) => Promise<unknown> } }).fh;
    const gate = barrier(fh, 'writev', 1);
    const pA = wal.append(Buffer.alloc(1024 * 1024, 0x61));
    await gate.entered; // batch A is inside writev now
    const pB = wal.append(Buffer.from('B')); // queued behind the in-flight batch
    const flushing = wal.flush(); // must await A AND then drain B
    gate.release();
    await flushing;
    const pending = (wal as unknown as { queue: unknown[] }).queue.length;
    gate.restore();
    await wal.close();
    await pA;
    await pB;
    expect(pending, 'flush() must leave nothing queued').toBe(0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- P0: compaction must not lose concurrent writes (clean restart) ---------

for (const policy of ['always', 'everysec', 'no'] as const) {
  test(`compact + concurrent writes survive clean close+reopen (fsync=${policy})`, async () => {
    const dir = await tmpDir();
    try {
      const db = await MiniDb.open({
        dir,
        valueCodec: 'string',
        fsyncPolicy: policy,
        compactThresholdBytes: 1,
        autoCompact: false,
      });
      for (let i = 0; i < 50; i++) await db.set(`seed${i}`, 'x'.repeat(64));

      const N = 500;
      const big = 'y'.repeat(4096);
      const writes: Promise<void>[] = [];
      for (let i = 0; i < N; i++) writes.push(db.set(`live${i}`, big));
      await Promise.all([db.compact(), ...writes]);
      await db.close();

      const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
      const lost: string[] = [];
      for (let i = 0; i < N; i++) if (db2.get(`live${i}`) !== big) lost.push(`live${i}`);
      await db2.close();
      expect(lost, `lost ${lost.length}/${N} keys: ${lost.slice(0, 5).join(',')}`).toStrictEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

// --- P0: TTL expiration must drop derived index entries ---------------------

test('expired keys are removed from secondary indexes', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 20 });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { city: 'Paris' }, { ttl: 30 });
    await new Promise((r) => setTimeout(r, 120));
    expect(db.get('u1')).toBe(undefined);
    expect(db.findEq('byCity', 'Paris')).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired keys are removed from the full-text index', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 20 });
    await db.createTextIndex('body');
    await db.set('p1', { bio: 'hello world' }, { ttl: 30 });
    await new Promise((r) => setTimeout(r, 120));
    expect(db.search('body', 'hello')).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- P1: batch() must enforce unique indexes within the batch ---------------

test('batch() rejects intra-batch unique violations', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byMail', { field: 'email', unique: true });
    await assert.rejects(
      db.batch([
        { op: 'set', key: 'a', value: { email: 'duplicate@example.test' } },
        { op: 'set', key: 'b', value: { email: 'duplicate@example.test' } },
      ]),
      /unique/i,
    );
    expect(db.get('a'), 'nothing committed on failure').toBe(undefined);
    expect(db.get('b')).toBe(undefined);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- P1: recovery must drop records whose TTL already elapsed ---------------

test('recovery drops expired records (size consistent with scan)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    await db.set('ephemeral', 'v', { ttl: 1 });
    await db.set('stable', 'ok');
    await new Promise((r) => setTimeout(r, 20));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    expect(db.size).toBe(1);
    expect(db.scan().length).toBe(1);
    expect(db.get('ephemeral')).toBe(undefined);
    expect(db.get('stable')).toBe('ok');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- concurrent sets keep the unique index consistent ----------------------

test('concurrent sets cannot both commit the same unique value', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byMail', { field: 'email', unique: true });
    const results = await Promise.allSettled([
      db.set('a', { email: 'shared@example.test' }),
      db.set('b', { email: 'shared@example.test' }),
    ]);
    const committed = results.filter((r) => r.status === 'fulfilled').length;
    const hits = db.findEq('byMail', 'shared@example.test');
    await db.close();
    expect(committed <= 1, `both committed: ${JSON.stringify(hits)}`).toBeTruthy();
    expect(hits.length <= 1, `unique violated: ${JSON.stringify(hits)}`).toBeTruthy();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
