// test/e2e/recovery-matrix.test.ts
//
// Matrix of recovery scenarios: WAL corruption at head/mid/tail under
// 'resync' vs 'strict', and snapshot + WAL combinations.

import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { HEADER_SIZE, CRC_SIZE } from '../../src/codec.js';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

// key 'kN'(2B) + value 'vN'(2B), no meta -> 22+2+2+0+4 = 30 bytes / frame
const FRAME = HEADER_SIZE + 2 + 2 + 0 + CRC_SIZE;

async function writeTen(dir) {
  // Legacy recovery semantics (indexGenerations: false): a published
  // generation's checkpoint would absorb the very frames these tests corrupt.
  const db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    fsyncPolicy: 'always',
    autoCompact: false,
    indexGenerations: false,
  });
  for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
  await db.close();
}

async function corruptWalFrame(dir, frameIndex) {
  const walPath = path.join(dir, 'db.wal');
  const buf = await fs.readFile(walPath);
  buf[frameIndex * FRAME + HEADER_SIZE + 2] ^= 0xff; // flip a value byte -> bad crc
  await fs.writeFile(walPath, buf);
}

const POS = { head: 0, mid: 5, tail: 9 };

for (const mode of ['resync', 'strict']) {
  for (const [where, idx] of Object.entries(POS)) {
    test(`recovery-matrix: WAL corrupt at ${where}, mode=${mode}`, async () => {
      const dir = await tmpDir();
      try {
        await writeTen(dir);
        await corruptWalFrame(dir, idx);
        const db = await MiniDb.open({
          dir,
          valueCodec: 'string',
          recovery: mode,
          indexGenerations: false,
        });
        const present = new Set(
          Array.from({ length: 10 }, (_, i) => 'k' + i).filter((k) => db.get(k) !== undefined),
        );

        if (where === 'tail') {
          // last frame bad -> truncated, everything else recovered
          expect(db.recoveryInfo.truncatedWal).toBe(true);
          expect(present.size).toBe(9);
          expect(!present.has('k9')).toBeTruthy();
        } else if (mode === 'resync') {
          // only the bad frame lost
          expect(present.size).toBe(9);
          expect(!present.has('k' + idx)).toBeTruthy();
        } else {
          // strict: everything from the bad frame onward lost
          for (let i = 0; i < 10; i++) {
            if (i < idx) expect(present.has('k' + i), `k${i} should survive`).toBeTruthy();
            else expect(!present.has('k' + i), `k${i} should be lost (strict)`).toBeTruthy();
          }
        }
        await db.close();
      } finally {
        await rmrf(dir);
      }
    });
  }
}

test('recovery-matrix: clean WAL recovers everything (both modes)', async () => {
  for (const mode of ['resync', 'strict']) {
    const dir = await tmpDir();
    try {
      await writeTen(dir);
      const db = await MiniDb.open({
        dir,
        valueCodec: 'string',
        recovery: mode,
        indexGenerations: false,
      });
      expect(db.size).toBe(10);
      expect(db.recoveryInfo.lostBytes).toBe(0);
      await db.close();
    } finally {
      await rmrf(dir);
    }
  }
});

test('recovery-matrix: snapshot present, empty WAL', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'always',
      autoCompact: false,
    });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    await db.close();
    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db2.recoveryInfo.snapshotFrames).toBe(10);
    expect(db2.recoveryInfo.walFrames).toBe(0);
    expect(db2.size).toBe(10);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('recovery-matrix: snapshot + clean WAL', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'always',
      autoCompact: false,
    });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    for (let i = 0; i < 5; i++) await db.set('a' + i, 'b' + i); // new WAL writes
    await db.close();
    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db2.size).toBe(15);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('recovery-matrix: snapshot + corrupt WAL mid (resync keeps snapshot + surviving WAL)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'always',
      autoCompact: false,
    });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    for (let i = 0; i < 5; i++) await db.set('a' + i, 'b' + i); // 5 new WAL frames
    await db.close();
    await corruptWalFrame(dir, 2); // corrupt 'a2' in the new WAL
    const db2 = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'resync' });
    expect(db2.get('a2'), 'corrupt WAL frame lost').toBe(undefined);
    expect(db2.get('a0')).toBe('b0');
    expect(db2.get('a4')).toBe('b4');
    expect(db2.size).toBe(14); // 10 snapshot + 4 surviving WAL
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});
