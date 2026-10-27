import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/batch.test.ts
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-batch-'));
}

test('batch applies multiple ops atomically', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    await db.batch([
      { op: 'set', key: 'a', value: { n: 1 } },
      { op: 'set', key: 'b', value: { n: 2 } },
      { op: 'del', key: 'a' },
    ]);
    expect(db.get('a')).toBe(undefined);
    expect(db.get('b')).toStrictEqual({ n: 2 });
    expect(db.size).toBe(1);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch with dt + indexes updates everything', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byCity', { field: 'city' });
  try {
    await db.batch([
      { op: 'set', key: 'u1', value: { city: 'Paris' }, dt: { created: 100 } },
      { op: 'set', key: 'u2', value: { city: 'Paris' }, dt: { created: 200 } },
    ]);
    expect(db
        .findEq('byCity', 'Paris')
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['u1', 'u2']);
    expect(db
        .dtRange('created', { gte: 100 })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['u1', 'u2']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch unique violation rejects the whole batch', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byEmail', { field: 'email', unique: true });
  await db.set('a', { email: 'duplicate@example.test' });
  try {
    await assert.rejects(
      () =>
        db.batch([
          { op: 'set', key: 'b', value: { email: 'unique@example.test' } },
          { op: 'set', key: 'c', value: { email: 'duplicate@example.test' } },
        ]),
      /unique/,
    );
    // neither op applied
    expect(db.get('b')).toBe(undefined);
    expect(db.get('c')).toBe(undefined);
    expect(db.size).toBe(1);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch is atomic on recovery: a corrupt batch frame skips the whole batch', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'always',
      autoCompact: false,
    });
    await db.set('before', { v: 0 });
    await db.batch([
      { op: 'set', key: 'x', value: { v: 1 } },
      { op: 'set', key: 'y', value: { v: 2 } },
    ]);
    await db.set('after', { v: 3 });
    await db.close();

    // Corrupt the batch frame (the 2nd frame, between 'before' and 'after').
    const wal = path.join(dir, 'db.wal');
    const buf = await fs.readFile(wal);
    const magic = Buffer.from([0x4d, 0x44]);
    const second = buf.indexOf(magic, buf.indexOf(magic) + 1); // start of batch frame
    buf[second + 30] ^= 0xff; // flip a byte inside the batch body -> bad crc
    await fs.writeFile(wal, buf);

    db = await MiniDb.open({ dir, valueCodec: 'json', recovery: 'resync' });
    expect(db.get('before').v, 'before survives').toBe(0);
    // the batch is either fully skipped or (if resync lands inside) neither x nor y appears
    // — but it must NEVER be the case that only one of x/y is present.
    const x = db.get('x');
    const y = db.get('y');
    expect(!(x !== undefined && y === undefined), 'batch must not be half-applied (x only)').toBeTruthy();
    expect(!(x === undefined && y !== undefined), 'batch must not be half-applied (y only)').toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('empty batch is a no-op', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    await db.batch([]);
    expect(db.size).toBe(0);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
