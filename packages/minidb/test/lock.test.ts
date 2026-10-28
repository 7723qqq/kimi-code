import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/lock.test.ts
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';
import { LockError, LockFile } from '../src/lockfile.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

test('a second writer on the same dir is rejected with LockError', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await expect((() => MiniDb.open({ dir, valueCodec: 'string' }))()).rejects.toThrow(LockError);
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('lock is released on close, allowing another writer', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  await db1.close();

  const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
  expect(db2.get('a')).toBe('1');
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('readOnly open succeeds alongside a writer and rejects writes', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    const ro = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
    expect(ro.readOnly).toBe(true);
    expect(ro.get('a')).toBe('1');
    await expect((() => ro.set('b', '2'))()).rejects.toThrow(/read-only/);
    await ro.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("onLockFail: 'readonly' degrades instead of throwing", async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    const db2 = await MiniDb.open({ dir, valueCodec: 'string', onLockFail: 'readonly' });
    expect(db2.readOnly).toBe(true);
    await db2.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a stale lock (dead PID) is taken over', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), JSON.stringify({ pid: 999999, ts: Date.now() }));
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  expect(db.readOnly).toBe(false);
  await db.set('a', '1');
  expect(db.get('a')).toBe('1');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// ---- owner token: per-instance ownership (review #10/#11 regression) ------

test(
  'two same-process contenders over a stale corpse: exactly one wins, zero double-wins',
  { timeout: 120_000 },
  async () => {
    const dir = await tmpDir();
    try {
      const lockPath = path.join(dir, 'db.lock');
      for (let i = 0; i < 100; i++) {
        await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
        const a = new LockFile(lockPath);
        const b = new LockFile(lockPath);
        const wins = await Promise.all([a.acquire(), b.acquire()]);
        expect(wins.filter(Boolean).length, `iteration ${i}: exactly one winner`).toBe(1);
        await a.release();
        await b.release();
        // The winner's release unlinked its own lock; nothing may be left.
        expect(await fs.stat(lockPath).then(
            () => true,
            () => false,
          ), `iteration ${i}: lock released`).toBe(false);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a racing renew() never re-publishes a released lock (100 iterations)',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir();
    try {
      for (let i = 0; i < 100; i++) {
        const lockPath = path.join(dir, `db-${i}.lock`);
        const lock = new LockFile(lockPath);
        expect(await lock.acquire()).toBe(true);
        await Promise.all([lock.renew(), lock.release()]);
        expect(lock.held).toBe(false);
        expect(await fs.stat(lockPath).then(
            () => true,
            () => false,
          ), `iteration ${i}: no ghost lock`).toBe(false);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('renew() keeps the owner token, so release() still recognizes the lock', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    expect(await lock.acquire()).toBe(true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    await lock.renew();
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    expect(after.token, 'renew preserves the owner token').toBe(before.token);
    await lock.release();
    expect(await fs.stat(lockPath).then(
        () => true,
        () => false,
      )).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acquire() on an already-held lock is an idempotent true and does not re-mint the token', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    expect(await lock.acquire()).toBe(true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    expect(await lock.acquire(), 're-entrant acquire reports the held lock').toBe(true);
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    expect(after.token, 'token is not re-minted').toBe(before.token);
    await lock.release();
    expect(await fs.stat(lockPath).then(
        () => true,
        () => false,
      ), 'release still recognizes and unlinks its own lock').toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a legacy tokenless lock file is respected while alive and taken over when dead', async () => {
  const dir = await tmpDir();
  try {
    // Live same-pid owner without a token: respected exactly as before — the
    // protocol does not open a "I know the old instance is gone" backdoor.
    const livePath = path.join(dir, 'live.lock');
    const legacyLive = JSON.stringify({ pid: process.pid, ts: Date.now() });
    await fs.writeFile(livePath, legacyLive);
    const contender = new LockFile(livePath);
    expect(await contender.acquire()).toBe(false);
    expect(await fs.readFile(livePath, 'utf8'), 'live legacy lock untouched').toBe(legacyLive);

    // Dead-pid owner without a token: taken over via the stale rules, and the
    // new lock line carries the instance token.
    const deadPath = path.join(dir, 'dead.lock');
    await fs.writeFile(deadPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    const taker = new LockFile(deadPath);
    expect(await taker.acquire()).toBe(true);
    const taken = JSON.parse(await fs.readFile(deadPath, 'utf8')) as {
      pid: number;
      token?: string;
    };
    expect(taken.pid).toBe(process.pid);
    expect(typeof taken.token === 'string' && taken.token.startsWith(`${process.pid}:`), 'taken-over lock line carries the owner token').toBeTruthy();
    await taker.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- close() state machine: exception-safe cleanup (review #12 regression) -

test('close() still releases the lock when the WAL close fails; a retry finishes the cleanup', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    const internals = db as unknown as { wal: { close(): Promise<void> } };
    const originalClose = internals.wal.close.bind(internals.wal);
    let failClose = true;
    internals.wal.close = async () => {
      await originalClose();
      if (failClose) {
        failClose = false;
        throw new Error('injected close failure');
      }
    };
    const err = await db.close().catch((error: unknown) => error);
    expect(err instanceof AggregateError, 'close failure is aggregated').toBeTruthy();
    expect(err.errors.length).toBe(1);
    expect(String(String(err.errors[0]))).toMatch(/injected close failure/);
    // The lock release was NOT skipped by the WAL failure.
    expect(await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ), 'lock released despite the WAL close failure').toBe(false);
    // Idempotent continuation: the second pass completes the cleanup.
    await db.close();
    await db.close(); // fully closed now: a no-op
    // The directory is free: a fresh writer opens with no LockError.
    const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    expect(reopened.get('a')).toBe('1');
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() aggregates every cleanup error instead of stopping at the first', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    const internals = db as unknown as {
      wal: { close(): Promise<void> };
      lock: { release(): Promise<void> } | null;
    };
    const originalWalClose = internals.wal.close.bind(internals.wal);
    let failWal = true;
    internals.wal.close = async () => {
      await originalWalClose();
      if (failWal) {
        failWal = false;
        throw new Error('injected wal close failure');
      }
    };
    const lock = internals.lock!;
    const originalRelease = lock.release.bind(lock);
    let failRelease = true;
    lock.release = async () => {
      if (failRelease) {
        failRelease = false;
        throw new Error('injected lock release failure');
      }
      return originalRelease();
    };
    const err = await db.close().catch((error: unknown) => error);
    expect(err instanceof AggregateError, 'close failure is aggregated').toBeTruthy();
    expect(err.errors.map((e) => (e instanceof Error ? e.message : String(e))), 'AggregateError carries every cleanup error').toStrictEqual(['injected wal close failure', 'injected lock release failure']);
    // Retry: the WAL close is now a no-op, the lock release runs for real.
    await db.close();
    expect(await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ), 'lock released on the retry').toBe(false);
    // The instance refused use from the first 'closing' transition on.
    await expect((() => db.set('b', '2'))()).rejects.toThrow(/MiniDb is closed/);
    await expect((() => db.compact())()).rejects.toThrow(/MiniDb is closed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() waits out a failing in-flight compaction and still cleans up every resource', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    // Keep the compaction deterministically in flight when close() starts, and
    // fail it (via the onCompacted hook, a real compactError path) while
    // close() is parked on _compactDone.
    let failHook: ((e: Error) => void) | undefined;
    db.onCompacted = () =>
      new Promise<void>((_, reject) => {
        failHook = reject;
      });
    const compacted = db.compact().catch(() => {});
    // Wait until the compaction actually reaches the injected hook (the
    // compacting flag flips long before the hook is invoked).
    while (!failHook) await new Promise((r) => setTimeout(r, 1));
    const closing = db.close();
    failHook(new Error('injected compaction failure'));
    await compacted;
    // The compaction failure is accounted on the instance, but close() must
    // not reject with it and must not skip the cleanup.
    await closing;
    expect(String(String(db.lastCompactError))).toMatch(/injected compaction failure/);
    expect(await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ), 'lock released despite the failed compaction').toBe(false);
    await db.close(); // fully closed now: a no-op
    const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('onLockAcquired fires with the held token; read-only fallback opens skip it', async () => {
  const dir = await tmpDir();
  let reported;
  const db1 = await MiniDb.open({
    dir,
    valueCodec: 'string',
    onLockAcquired: (info) => {
      reported = info.token;
    },
  });
  try {
    // Fired before open() resolved, and matches the published lock line —
    // a supervisor learns the lock identity before any heavy recovery ran.
    expect(reported).toBeTruthy();
    const line = JSON.parse(await fs.readFile(path.join(dir, 'db.lock'), 'utf8'));
    expect(line.token).toBe(reported);
    expect(line.pid).toBe(process.pid);

    // A read-only fallback open (the lock is busy) never fires the callback.
    let second;
    const ro = await MiniDb.open({
      dir,
      valueCodec: 'string',
      onLockFail: 'readonly',
      onLockAcquired: (info) => {
        second = info.token;
      },
    });
    expect(ro.readOnly).toBe(true);
    expect(second).toBe(undefined);
    await ro.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
