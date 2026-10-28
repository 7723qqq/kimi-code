import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Exercises defensive input/state-validation branches that are reachable
// through the public/direct API but were not covered by the functional tests.
// Fault-injection-only branches (writev short-write, fsync failure, >64MB
// RESP payload, cross-user EPERM, process-exit hook) are intentionally not
// covered here — see the coverage summary in the commit message.
import { expect, test } from 'bun:test';

import { encodeFrame, decodeBatchOps, TYPE_SET } from '../src/codec.js';
import { MiniDb } from '../src/index.js';
import { LockFile } from '../src/lockfile.js';
import { startServer } from '../src/server.js';
import { WAL } from '../src/wal.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-defense-'));
}

const B = (s: string) => Buffer.from(s);

// --- codec.encodeFrame input validation ------------------------------------

test('encodeFrame rejects a non-buffer key', () => {
  expect(() => encodeFrame({ type: TYPE_SET, key: 'x' as unknown as Buffer, value: B('v') })).toThrow(/key must be a Buffer/);
});

test('encodeFrame rejects an oversized key', () => {
  const big = Buffer.alloc(0xffff + 1);
  expect(() => encodeFrame({ type: TYPE_SET, key: big, value: B('v') })).toThrow(/key too large/);
});

test('encodeFrame rejects a SET with a non-buffer value', () => {
  expect(() => encodeFrame({ type: TYPE_SET, key: B('k'), value: 'not-a-buffer' as unknown as Buffer })).toThrow(/value must be a Buffer for SET/);
});

test('encodeFrame rejects a non-buffer meta', () => {
  expect(() =>
      encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v'), meta: 'x' as unknown as Buffer })).toThrow(/meta must be a Buffer/);
});

// --- codec.decodeBatchOps bounds checks ------------------------------------

test('decodeBatchOps rejects a body shorter than the count field', () => {
  // Strict structure validation (stage 11, review #9): a body that cannot
  // even carry the op count is malformed — never a silent empty batch.
  expect(() => decodeBatchOps(Buffer.alloc(0))).toThrow(/batch body truncated: op count/);
  expect(() => decodeBatchOps(Buffer.alloc(1))).toThrow(/batch body truncated: op count/);
});

test('decodeBatchOps throws on a truncated op header', () => {
  // count = 1 but no op bytes follow.
  const body = Buffer.alloc(2);
  body.writeUInt16LE(1, 0);
  expect(() => decodeBatchOps(body)).toThrow(/batch op header truncated/);
});

test('decodeBatchOps throws on a truncated op payload', () => {
  // Build one op header claiming a 100-byte key, then cut the body short.
  const header = Buffer.alloc(1 + 2 + 4 + 4 + 8);
  let o = 0;
  header.writeUInt8(TYPE_SET, o);
  o += 1;
  header.writeUInt16LE(100, o);
  o += 2;
  header.writeUInt32LE(0, o);
  o += 4;
  header.writeUInt32LE(0, o);
  o += 4;
  header.writeBigInt64LE(0n, o);
  const body = Buffer.concat([Buffer.from([1, 0]), header]); // count=1 + header, no payload
  expect(() => decodeBatchOps(body)).toThrow(/batch op payload truncated/);
});

// --- WAL input/state validation --------------------------------------------

test('WAL constructor rejects an unknown fsyncPolicy', () => {
  expect(() => new WAL('/tmp/x', { fsyncPolicy: 'bogus' as never })).toThrow(/unknown fsyncPolicy/);
});

test('WAL append rejects a non-buffer frame', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'no' });
  await wal.open();
  try {
    await expect((() => wal.append('x' as unknown as Buffer))()).rejects.toThrow(/frame must be a Buffer/);
  } finally {
    await wal.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WAL append after close rejects', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'no' });
  await wal.open();
  await wal.close();
  await expect((() => wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') })))()).rejects.toThrow(/WAL is closed/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL open and close are idempotent', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'everysec' });
  await expect(wal.open()).resolves.toBeUndefined();
  await expect(wal.open()).resolves.toBeUndefined(); // second open is a no-op
  await expect(wal.close()).resolves.toBeUndefined();
  await expect(wal.close()).resolves.toBeUndefined(); // second close is a no-op
  await fs.rm(dir, { recursive: true, force: true });
});

// --- LockFile stale / corrupt handling -------------------------------------

test('LockFile.acquire returns false when a live process holds the lock', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  const a = new LockFile(p);
  expect(await a.acquire()).toBe(true);
  const b = new LockFile(p);
  expect(await b.acquire()).toBe(false); // same PID is alive -> not stale
  await a.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a corrupt lock file is treated as stale and taken over', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), 'not-json');
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  expect(db.get('a')).toBe('1');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a lock file with a non-numeric pid is treated as stale', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), JSON.stringify({ pid: 'abc' }));
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  expect(db.readOnly).toBe(false);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('LockFile release/releaseSync are no-ops when not held', async () => {
  const dir = await tmpDir();
  const lock = new LockFile(path.join(dir, 'db.lock'));
  await expect(Promise.resolve(lock.release())).resolves.toBeUndefined();
  expect(() => lock.releaseSync()).not.toThrow();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- snapshot / compaction edge cases --------------------------------------

test('compacting an empty database produces an empty snapshot and keeps data intact', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await db.compact(); // empty store -> flushBatch early-return
  expect(db.stats.compactions).toBe(1);
  const snap = await fs.stat(path.join(dir, 'db.snapshot'));
  expect(snap.size).toBe(0);
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  expect(db.size).toBe(0);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a second concurrent compact() reuses the in-flight compaction', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  for (let i = 0; i < 100; i++) await db.set(`k${i}`, `v${i}`);
  const p1 = db.compact();
  const p2 = db.compact(); // compacting === true -> early-returns, reusing the in-flight work
  // (compact is `async`, so each call wraps the shared _compactDone in a fresh
  //  promise; the guard is what prevents a second compaction from running.)
  await Promise.all([p1, p2]);
  expect(db.stats.compactions).toBe(1);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- key validation --------------------------------------------------------

test('set rejects an empty key', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await expect((() => db.set('', 'v'))()).rejects.toThrow(/key must be non-empty/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch rejects an empty key', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await expect((() => db.batch([{ op: 'set', key: '', value: 'v' }]))()).rejects.toThrow(/key must be non-empty/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('del / expire validate the key before probing the store', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  const tooLong = 'k'.repeat(200);
  await expect((() => db.del(tooLong))()).rejects.toThrow(/key too long/);
  await db.set('present', 'v');
  await expect((() => db.expire(tooLong, 1000))()).rejects.toThrow(/key too long/);
  expect(await db.del('absent'), 'deleting a missing valid key is still false').toBe(false);
  expect(await db.expire('absent', 1000), 'expiring a missing valid key is still false').toBe(false);
  expect(await db.get('present')).toBe('v');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- index lookup errors ---------------------------------------------------

test('findEq / findRange on a missing index throw', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  expect(() => db.findEq('nope', 'x')).toThrow(/no such index/);
  expect(() => db.findRange('nope', {})).toThrow(/no such index/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('compoundRange on a missing index throws', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  expect(() => db.compoundRange('nope', 'g')).toThrow(/no such compound index/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- RESP error reply ------------------------------------------------------

test('RESP server replies with -ERR when a command throws', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(srv.port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const r = await new Promise<string>((resolve) => {
      sock.once('data', (d) => resolve(d.toString()));
      // 129-byte key exceeds MAX_KEY_LEN -> db.set throws -> server replies -ERR.
      const key = 'x'.repeat(129);
      sock.write(`*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$1\r\nv\r\n`);
    });
    expect(r.startsWith('-ERR'), r).toBeTruthy();
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
