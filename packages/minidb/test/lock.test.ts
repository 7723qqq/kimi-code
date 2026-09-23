import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/lock.test.ts
import { test } from 'vitest';

import { MiniDb } from '../src/index.js';
import { LockError, LockFile } from '../src/lockfile.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

test('a second writer on the same dir is rejected with LockError', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await assert.rejects(() => MiniDb.open({ dir, valueCodec: 'string' }), LockError);
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
  assert.equal(db2.get('a'), '1');
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('readOnly open succeeds alongside a writer and rejects writes', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    const ro = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
    assert.equal(ro.readOnly, true);
    assert.equal(ro.get('a'), '1');
    await assert.rejects(() => ro.set('b', '2'), /read-only/);
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
    assert.equal(db2.readOnly, true);
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
  assert.equal(db.readOnly, false);
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
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
        assert.equal(wins.filter(Boolean).length, 1, `iteration ${i}: exactly one winner`);
        await a.release();
        await b.release();
        // The winner's release unlinked its own lock; nothing may be left.
        assert.equal(
          await fs.stat(lockPath).then(
            () => true,
            () => false,
          ),
          false,
          `iteration ${i}: lock released`,
        );
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
        assert.equal(await lock.acquire(), true);
        // The property under test is the RACE: the serializer must run renew to
        // completion before release unlinks, so release can never be followed by
        // renew re-publishing the lock. A renew that cannot land its rename is a
        // different failure — on Windows an on-access scanner holds the freshly
        // written temp for a moment and the rename exhausts its budget — and it
        // cannot affect the property: renew that never replaced the line leaves
        // the lock exactly as release found it. Tolerating the rejection here
        // keeps the assertion on the race, with the ghost-lock check below as
        // the thing that must hold either way.
        await Promise.all([lock.renew().catch(() => {}), lock.release()]);
        assert.equal(lock.held, false);
        assert.equal(
          await fs.stat(lockPath).then(
            () => true,
            () => false,
          ),
          false,
          `iteration ${i}: no ghost lock`,
        );
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('renew() leaves no temp behind when the rename cannot land', async () => {
  const dir = await tmpDir();
  try {
    // Make the destination unreplaceable: a non-empty DIRECTORY at the lock
    // path, which rename cannot replace on any platform. The failing renew
    // must still clean up its temp — open()'s stale-temp sweep never matches
    // LockFile temps (they can be in flight in another process), so each
    // failure accumulated one. `renew()` is a no-op unless held, so the
    // instance is marked held to reach the rename.
    const blockedPath = path.join(dir, 'blocked.lock');
    await fs.mkdir(blockedPath);
    await fs.writeFile(path.join(blockedPath, 'blocker'), 'x');
    const blocked = new LockFile(blockedPath);
    blocked.held = true;

    await blocked.renew().catch(() => {});
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith('blocked.lock.tmp-'));
    assert.deepEqual(leftovers, [], 'no orphaned renew temp');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renew() keeps the owner token, so release() still recognizes the lock', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    assert.equal(await lock.acquire(), true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    await lock.renew();
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(after.token, before.token, 'renew preserves the owner token');
    await lock.release();
    assert.equal(
      await fs.stat(lockPath).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acquire() on an already-held lock is an idempotent true and does not re-mint the token', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    assert.equal(await lock.acquire(), true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(await lock.acquire(), true, 're-entrant acquire reports the held lock');
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(after.token, before.token, 'token is not re-minted');
    await lock.release();
    assert.equal(
      await fs.stat(lockPath).then(
        () => true,
        () => false,
      ),
      false,
      'release still recognizes and unlinks its own lock',
    );
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
    assert.equal(await contender.acquire(), false);
    assert.equal(await fs.readFile(livePath, 'utf8'), legacyLive, 'live legacy lock untouched');

    // Dead-pid owner without a token: taken over via the stale rules, and the
    // new lock line carries the instance token.
    const deadPath = path.join(dir, 'dead.lock');
    await fs.writeFile(deadPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    const taker = new LockFile(deadPath);
    assert.equal(await taker.acquire(), true);
    const taken = JSON.parse(await fs.readFile(deadPath, 'utf8')) as {
      pid: number;
      token?: string;
    };
    assert.equal(taken.pid, process.pid);
    assert.ok(
      typeof taken.token === 'string' && taken.token.startsWith(`${process.pid}:`),
      'taken-over lock line carries the owner token',
    );
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
    assert.ok(err instanceof AggregateError, 'close failure is aggregated');
    assert.equal(err.errors.length, 1);
    assert.match(String(err.errors[0]), /injected close failure/);
    // The lock release was NOT skipped by the WAL failure.
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ),
      false,
      'lock released despite the WAL close failure',
    );
    // Idempotent continuation: the second pass completes the cleanup.
    await db.close();
    await db.close(); // fully closed now: a no-op
    // The directory is free: a fresh writer opens with no LockError.
    const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    assert.equal(reopened.get('a'), '1');
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
    assert.ok(err instanceof AggregateError, 'close failure is aggregated');
    assert.deepEqual(
      err.errors.map((e) => (e instanceof Error ? e.message : String(e))),
      ['injected wal close failure', 'injected lock release failure'],
      'AggregateError carries every cleanup error',
    );
    // Retry: the WAL close is now a no-op, the lock release runs for real.
    await db.close();
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ),
      false,
      'lock released on the retry',
    );
    // The instance refused use from the first 'closing' transition on.
    await assert.rejects(() => db.set('b', '2'), /MiniDb is closed/);
    await assert.rejects(() => db.compact(), /MiniDb is closed/);
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
    assert.match(String(db.lastCompactError), /injected compaction failure/);
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(
        () => true,
        () => false,
      ),
      false,
      'lock released despite the failed compaction',
    );
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
    assert.ok(reported);
    const line = JSON.parse(await fs.readFile(path.join(dir, 'db.lock'), 'utf8'));
    assert.equal(line.token, reported);
    assert.equal(line.pid, process.pid);

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
    assert.equal(ro.readOnly, true);
    assert.equal(second, undefined);
    await ro.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Windows replaces a file by renaming over it, and a reader that lands in that
// window gets EPERM rather than ENOENT ("operation not permitted" opening a
// path that is momentarily being swapped). `inspect()` reads the lock file, and
// the lock line is rewritten by renew() and by a stale-lock takeover, so this
// window is reachable in normal operation — a cluster storm hit it and the
// open failed outright. Every other replace-sensitive read in this package
// rides the EPERM retry; inspect() must too.
test('inspect tolerates a transient EPERM while the lock line is being replaced', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    assert.equal(await lock.acquire(), true);

    // Fail the first read the way Windows does mid-replace, then serve it.
    const originalReadFile = fs.readFile;
    let injected = 0;
    fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
      if (injected === 0) {
        injected++;
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        return Promise.reject(err);
      }
      return originalReadFile(...args);
    }) as typeof fs.readFile;
    try {
      const holder = await lock.describeHolder();
      assert.equal(injected, 1, 'the injected EPERM was actually exercised');
      assert.equal(holder?.pid, process.pid, 'the holder is still reported');
      assert.equal(holder?.alive, true);
    } finally {
      fs.readFile = originalReadFile;
    }
    await lock.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The exit hook releases held locks, but it hung off `beforeExit`, which does
// NOT run when a process calls process.exit() (or dies on an uncaught throw) —
// so an ordinary exit could leave the lock line behind. The hook is
// best-effort by design: a SIGKILL still cannot be caught, and a surviving
// line is reclaimed as stale. But `exit` is what fires on the paths that
// actually happen, and releaseSync is synchronous, so it belongs there too.
test('a process exiting via process.exit() does not leave its lock behind', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const script = `
      import { LockFile } from ${JSON.stringify(new URL('../src/lockfile.ts', import.meta.url).href)};
      const lock = new LockFile(${JSON.stringify(lockPath)});
      await lock.acquire();
      process.exit(0);
    `;
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      // Bun executes .ts natively; Node needs the tsx loader hook.
      [...(typeof Bun !== 'undefined' ? [] : ['--import', 'tsx']), '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, `child exited cleanly; stderr=${stderr}`);
    const exists = await fs.stat(lockPath).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, 'the exit hook released the lock on process.exit()');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Exactly-one rests on the watch check: a contender may claim only once no
// OTHER contender's registration is on disk. That check lists the directory,
// and a listing that cannot be read must not be read as "no contender is in
// flight" — the same reason an unreadable registration counts as live. Read as
// empty, it lets a contender claim while a co-bidder is still mid-attempt, and
// the co-bidder then claims too: the double-win the watch check exists to
// prevent. (Reproduced by injecting a directory-listing failure together with
// a delayed co-bidder rename: two winners.)
test('a contender that cannot list the directory does not claim over a live co-bidder', async () => {
  const dir = await tmpDir();
  const originalReaddir = fs.readdir;
  try {
    const lockPath = path.join(dir, 'db.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    // A co-bidder mid-attempt: its registration is on disk for the whole
    // attempt, so this is exactly the state the check has to respect.
    const foreignWatch = `${lockPath}.watch-${process.pid}-999999`;
    await fs.writeFile(
      foreignWatch,
      JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'other:token' }),
    );

    fs.readdir = ((...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === dir) {
        const err = new Error('EPERM: operation not permitted, scandir') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        return Promise.reject(err);
      }
      return originalReaddir(...args);
    }) as typeof fs.readdir;

    const lock = new LockFile(lockPath);
    // The claim is the thing under test, so bound the wait instead of letting
    // a correct implementation settle forever: a contender that respects the
    // co-bidder never claims, and the timer wins the race. The contender is
    // still settling when the timer fires — removing the directory below is
    // what ends it, and `release()` cannot be used here because it queues
    // behind the acquire still in flight.
    const pending = lock.acquire();
    const claimed = await Promise.race([
      pending,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(claimed, false, 'must not claim while a co-bidder is in flight');
    void pending.catch(() => {});
  } finally {
    // The listing stays broken until the directory is gone, so the settling
    // contender can only ever exit through the vanished lock file.
    await fs.rm(dir, { recursive: true, force: true });
    fs.readdir = originalReaddir;
  }
});
