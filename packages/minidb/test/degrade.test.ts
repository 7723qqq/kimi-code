import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/degrade.test.ts
import { expect, test } from 'bun:test';

import { encodeFrame, TYPE_SET, CorruptFrameError } from '../src/codec.js';
import { MiniDb, classifyStorageError } from '../src/index.js';
import { LockError } from '../src/lockfile.js';
import { retryEperm } from '../src/rename-replace.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-degrade-'));
}

test('openOrRebuild preserves data when only a sidecar definition file is corrupt', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byX', { field: 'x' });
  await db.set('important', { x: 1 });
  await db.close();

  // Corrupt the index-definitions file so open() throws during load.
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json');

  let rebuilt = null;
  db = await MiniDb.openOrRebuild({ dir, valueCodec: 'json' }, { onRebuild: (e) => (rebuilt = e) });
  expect(rebuilt instanceof Error, 'onRebuild called with the original error').toBeTruthy();
  // the sidecar (pure derived state) is dropped, the data is NOT wiped
  expect(db.size).toBe(1);
  expect(db.get('important')).toStrictEqual({ x: 1 });
  expect(db.listIndexes()).toStrictEqual([]);
  // indexes can be recreated and the db is usable again
  await db.createIndex('byX', { field: 'x' });
  expect(db.findEq('byX', 1).length).toBe(1);
  await db.set('fresh', { v: 1 });
  expect(db.get('fresh')).toStrictEqual({ v: 1 });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('openOrRebuild does NOT delete a live-locked db', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    await assert.rejects(() => MiniDb.openOrRebuild({ dir, valueCodec: 'string' }), LockError);
    // data still there
    expect(await fs.stat(path.join(dir, 'db.wal'))).toBeTruthy();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild with onLockFail readonly must not mutate a live writer: corrupt sidecar is rethrown, not "repaired" (lock-review repro)', async () => {
  const dir = await tmpDir();
  const writer = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await writer.set('kept', 'value');
  // A corrupt secondary-index sidecar: a plain readonly open fails on it with
  // a SyntaxError, which openOrRebuild would normally "fix" by dropping the
  // sidecar — but the readonly fallback must never delete a live writer's
  // files.
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{broken-json');
  try {
    await assert.rejects(
      MiniDb.openOrRebuild<string>({
        dir,
        valueCodec: 'string',
        fsyncPolicy: 'no',
        onLockFail: 'readonly',
      }),
      SyntaxError,
    );
    const sidecar = await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8');
    expect(sidecar, 'the live writer’s sidecar is untouched').toBe('{broken-json');
    expect(writer.get('kept'), 'the live writer is undisturbed').toBe('value');
  } finally {
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild with onLockFail readonly + a garbage WAL (strict) degrades to a live read-only view and never wipes the directory (lock-review repro)', async () => {
  const dir = await tmpDir();
  const writer = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await writer.set('kept', 'value');
  // A garbage WAL. Strict recovery at HEAD stops at the first bad frame
  // instead of throwing (stage 7/9 semantics), so the readonly open succeeds;
  // the historical bug this pins is the full-directory wipe openOrRebuild ran
  // when such an open DID fail destructively.
  await fs.writeFile(path.join(dir, 'db.wal'), Buffer.from('not-a-valid-frame'));
  const walBefore = await fs.readFile(path.join(dir, 'db.wal'));
  try {
    const rebuilt = await MiniDb.openOrRebuild<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      recovery: 'strict',
      onLockFail: 'readonly',
    });
    expect(rebuilt.readOnly, 'degraded to read-only behind the live writer').toBe(true);
    expect(rebuilt.get('kept'), 'the garbage WAL replays nothing').toBe(undefined);
    await rebuilt.close();
    const walAfter = await fs.readFile(path.join(dir, 'db.wal'));
    expect(walBefore.equals(walAfter), 'the live writer’s WAL is byte-identical').toBeTruthy();
    expect(writer.get('kept'), 'the live writer is undisturbed').toBe('value');
    // The writer's own lock line is still on disk (no fresh db was opened
    // over the directory).
    const lockRaw = JSON.parse(await fs.readFile(path.join(dir, 'db.lock'), 'utf8')) as {
      token?: string;
    };
    expect(typeof lockRaw.token, 'lock file intact').toBe('string');
  } finally {
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild refuses to destructively rebuild by default when the data files are corrupt', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('precious', { keep: true });
  await db.close();

  const walPath = path.join(dir, 'db.wal');
  const walLenBefore = (await fs.stat(walPath)).size;
  await fs.appendFile(
    walPath,
    encodeFrame({
      type: TYPE_SET,
      key: Buffer.from('poison'),
      value: Buffer.from('"x"'),
      meta: Buffer.from('{not-json'),
    }),
  );

  await assert.rejects(
    MiniDb.openOrRebuild({ dir, valueCodec: 'json' }),
    (e: unknown) => e instanceof Error && /allowDestructiveRebuild/.test(e.message),
  );
  expect((await fs.stat(walPath)).size > walLenBefore, 'WAL untouched by the refused rebuild').toBeTruthy();
  // dropping the appended poison frame repairs the db: the data was never erased
  await fs.truncate(walPath, walLenBefore);
  const recovered = await MiniDb.open({ dir, valueCodec: 'json' });
  expect(recovered.get('precious')).toStrictEqual({ keep: true });
  await recovered.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('openOrRebuild wipes and reopens empty only with allowDestructiveRebuild', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('cache-entry', { v: 1 });
  await db.close();

  await fs.appendFile(
    path.join(dir, 'db.wal'),
    encodeFrame({
      type: TYPE_SET,
      key: Buffer.from('poison'),
      value: Buffer.from('"x"'),
      meta: Buffer.from('{not-json'),
    }),
  );

  let rebuilt: unknown = null;
  const db2 = await MiniDb.openOrRebuild(
    { dir, valueCodec: 'json' },
    { allowDestructiveRebuild: true, onRebuild: (e) => (rebuilt = e) },
  );
  expect(rebuilt instanceof Error, 'onRebuild called with the original error').toBeTruthy();
  expect(db2.size).toBe(0);
  await db2.set('fresh', { v: 1 });
  expect(db2.get('fresh')).toStrictEqual({ v: 1 });
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('classifyStorageError and retryEperm drive the rebuild/transient recovery policy', async () => {
  const walDisabled = Object.assign(new Error('disabled'), { code: 'WAL_WRITE_DISABLED' });
  const walPoisoned = Object.assign(new Error('poisoned'), { code: 'WAL_POISONED' });
  expect(classifyStorageError(walDisabled)).toBe('rebuild');
  expect(classifyStorageError(walPoisoned)).toBe('rebuild');
  expect(classifyStorageError(new CorruptFrameError('bad frame', 0))).toBe('rebuild');
  expect(classifyStorageError(new SyntaxError('unexpected token'))).toBe('rebuild');
  expect(classifyStorageError(new AggregateError([new Error('x'), walPoisoned], 'partial'))).toBe('rebuild');
  expect(classifyStorageError(new AggregateError([new Error('x'), new LockError('locked')], 'partial'))).toBe('transient');
  expect(classifyStorageError(new LockError('locked'))).toBe('transient');
  expect(classifyStorageError(Object.assign(new Error('perm'), { code: 'EPERM' }))).toBe('transient');
  expect(classifyStorageError(new Error('unknown'))).toBe('transient');

  const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  let attempts = 0;
  const recovered = await retryEperm(
    async () => {
      attempts += 1;
      if (attempts < 3) throw eperm();
      return 'ok';
    },
    { baseDelayMs: 1 },
  );
  expect(recovered).toBe('ok');
  expect(attempts).toBe(3);

  attempts = 0;
  await assert.rejects(
    retryEperm(async () => {
      attempts += 1;
      throw new Error('not eperm');
    }),
    /not eperm/,
  );
  expect(attempts).toBe(1);

  attempts = 0;
  await assert.rejects(
    retryEperm(
      async () => {
        attempts += 1;
        throw eperm();
      },
      { retries: 2, baseDelayMs: 1 },
    ),
    /operation not permitted/,
  );
  expect(attempts).toBe(3);
});
