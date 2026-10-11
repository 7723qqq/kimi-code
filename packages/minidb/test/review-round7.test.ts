import assert from 'node:assert/strict';

import { test } from 'vitest';

import { MiniDb } from '../src/index.js';
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
