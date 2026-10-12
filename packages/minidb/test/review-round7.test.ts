import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { test } from 'vitest';

import { classifyStorageError, MiniDb } from '../src/index.js';
import { rmrf, tmpDir } from './helpers.js';

// Regression tests for the H-class option-validation convergence:
//   Every enum / numeric option must be checked at the open boundary, so an
//   unrecognized value is a RangeError here instead of silently degrading at
//   its first use — `valueCodec` used to leave `codec` undefined until the
//   first write, `maxMemoryPolicy` fell back to `reject` behaviour, and
//   `recovery` fell back to `resync`.
//   D4) a negative TTL is rejected: it used to mean "already expired" and
//   dropped the value on the next read.

async function expectRejected(label: string, open: () => Promise<unknown>): Promise<void> {
  let threw: unknown;
  try {
    await open();
  } catch (error) {
    threw = error;
  }
  assert.ok(threw instanceof RangeError, `${label}: expected a RangeError`);
  assert.match((threw as Error).message, /unknown|must be/, `${label}: message was ${String((threw as Error).message)}`);
}

test('H: unrecognized enum options are rejected at open', async () => {
  const dirs = await Promise.all([
    tmpDir('minidb-h1-'),
    tmpDir('minidb-h2-'),
    tmpDir('minidb-h3-'),
    tmpDir('minidb-h4-'),
    tmpDir('minidb-h5-'),
  ]);
  try {
    await expectRejected('valueCodec', () =>
      MiniDb.open({ dir: dirs[0]!, valueCodec: 'bogus' as never }),
    );
    await expectRejected('maxMemoryPolicy', () =>
      MiniDb.open({ dir: dirs[1]!, maxMemoryPolicy: 'lru-ish' as never }),
    );
    await expectRejected('recovery', () =>
      MiniDb.open({ dir: dirs[2]!, recovery: 'resync!' as never }),
    );
    await expectRejected('fsyncPolicy', () =>
      MiniDb.open({ dir: dirs[3]!, fsyncPolicy: 'never' as never }),
    );
    await expectRejected('valueMode', () =>
      MiniDb.open({ dir: dirs[4]!, valueMode: 'network' as never }),
    );
  } finally {
    for (const d of dirs) await rmrf(d);
  }
});

test('H: non-finite and non-positive numeric options are rejected at open', async () => {
  const dirs = await Promise.all([
    tmpDir('minidb-hn1-'),
    tmpDir('minidb-hn2-'),
    tmpDir('minidb-hn3-'),
    tmpDir('minidb-hn4-'),
    tmpDir('minidb-hn5-'),
  ]);
  try {
    await expectRejected('syncIntervalMs NaN', () =>
      MiniDb.open({ dir: dirs[0]!, syncIntervalMs: Number.NaN }),
    );
    await expectRejected('syncIntervalMs negative', () =>
      MiniDb.open({ dir: dirs[1]!, syncIntervalMs: -1 }),
    );
    await expectRejected('compactThresholdBytes negative', () =>
      MiniDb.open({ dir: dirs[2]!, compactThresholdBytes: -1 }),
    );
    await expectRejected('textBuildMemoryBytes zero', () =>
      MiniDb.open({ dir: dirs[3]!, textBuildMemoryBytes: 0 }),
    );
    await expectRejected('maxMemoryBytes zero', () =>
      MiniDb.open({ dir: dirs[4]!, maxMemoryBytes: 0 }),
    );
  } finally {
    for (const d of dirs) await rmrf(d);
  }
});

test('H: valid options still open, and auto valueMode still resolves', async () => {
  const dir = await tmpDir('minidb-h-ok-');
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      maxMemoryPolicy: 'evict-lru',
      recovery: 'strict',
      valueMode: 'auto',
      syncIntervalMs: 500,
      compactThresholdBytes: 1024,
      maxMemoryBytes: 1024 * 1024,
    });
    await db.set('k', 'v');
    assert.equal(await db.get('k'), 'v');
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('F3: the default text-build memory budget is 128 MiB and is documented as such', async () => {
  const dirs = await Promise.all([
    tmpDir('minidb-f3-default-'),
    tmpDir('minidb-f3-explicit-'),
  ]);
  try {
    const defaulted = await MiniDb.open({ dir: dirs[0]!, valueCodec: 'string' });
    assert.equal(
      defaulted.textBuildMemoryBytes,
      128 * 1024 * 1024,
      'an omitted textBuildMemoryBytes must resolve to the documented 128 MiB',
    );
    await defaulted.close();

    const explicit = await MiniDb.open({
      dir: dirs[1]!,
      valueCodec: 'string',
      textBuildMemoryBytes: 32 * 1024 * 1024,
    });
    assert.equal(
      explicit.textBuildMemoryBytes,
      32 * 1024 * 1024,
      'an explicit textBuildMemoryBytes must still win over the default',
    );
    await explicit.close();
  } finally {
    for (const d of dirs) await rmrf(d);
  }
});

test('D4: a negative or non-finite TTL is rejected', async () => {
  const dir = await tmpDir('minidb-d4-');
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    for (const ttl of [-1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      let threw: unknown;
      try {
        await db.set('k', 'v', { ttl });
      } catch (error) {
        threw = error;
      }
      assert.ok(threw instanceof RangeError, `ttl ${String(ttl)} must be rejected`);
    }
    await db.set('real', 'v');
    for (const ttl of [-5, Number.NaN]) {
      let threw: unknown;
      try {
        await db.expire('real', ttl);
      } catch (error) {
        threw = error;
      }
      assert.ok(threw instanceof RangeError, `expire(${String(ttl)}) must be rejected`);
    }
    assert.equal(await db.expire('real', 60_000), true, 'a valid expire still works');
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

// a23/F3: a torn definition sidecar is not a local, recoverable defect — the
// open throws a SyntaxError and classifyStorageError maps it to 'rebuild', so
// every consumer (kap-server's indexCore, agent-core-v2's miniDbQueryStore)
// discards and re-creates the store. That is why writeFileAtomic must fsync the
// tmp content before renaming it (test/value-codec-fsync.test.ts pins the
// syscall order): without that fsync a power loss right after a successful
// createTextIndex can leave exactly this empty file behind.
test('a23/F3: a truncated db.textindexes.json makes open fail with a SyntaxError classified as rebuild', async () => {
  const dir = await tmpDir('minidb-a23f3-');
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('ft', { fields: ['t'] });
    await db.set('a', { t: 'hello' });
    await db.close();
    assert.notEqual(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8'), '');

    // A crash-torn sidecar: 0 bytes instead of the JSON the writer believed it
    // had made durable.
    await fs.writeFile(path.join(dir, 'db.textindexes.json'), '');

    let threw: unknown;
    try {
      const reopened = await MiniDb.open({ dir, valueCodec: 'json' });
      await reopened.close();
    } catch (error) {
      threw = error;
    }
    assert.ok(threw instanceof SyntaxError, `expected a SyntaxError, got ${String(threw)}`);
    assert.equal(
      classifyStorageError(threw),
      'rebuild',
      'the consumer policy for a torn definition file is a full rebuild',
    );
    // The authoritative data itself is untouched — the damage is entirely the
    // definition file, so a durable-by-construction sidecar write is what
    // stands between one power loss and a wiped search index.
    assert.equal((await fs.readdir(dir)).includes('db.wal'), true);
  } finally {
    await rmrf(dir);
  }
});
