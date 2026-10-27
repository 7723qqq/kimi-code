// test/compaction-fault.test.ts
//
// Fault-injection tests for the compaction helpers. The faults are injected by
// replacing properties on the real node:fs/promises exports object: every
// minidb module default-imports that one object, so a swap reaches compaction.ts
// without re-importing anything. These exercise branches that real filesystems
// essentially never produce (a write that returns 0 bytes, a close/sync that
// throws).
//
// The later sections cover compaction ROTATION failures end-to-end (through a
// real MiniDb on a real temp dir): a throw at wal.close(), at the WAL rename,
// at the new WAL's open(), or at the rotation's STRICT directory fsyncs must
// not wedge the database — the seal is one-way, so recovery swaps in a fresh
// WAL on db.walPath. A dir-fsync failure additionally must ABORT the rotation
// (it breaks the rename-durability invariant), leaving the disk on one of the
// crash-safe snapshot/WAL pairings.
//
// NOTE: each test patches the shared fs object and the afterEach below restores
// every patched property, so no test inherits another test's fault.

import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, spyOn, test } from 'bun:test';

import { copyFileRange, fsyncDir, isUnsupportedDirectoryFsyncError } from '../src/compaction.js';
import { encodeFrame, FrameParser, TYPE_SET } from '../src/codec.js';
import { MiniDb } from '../src/index.js';
import * as snapshot from '../src/snapshot.js';
import { WAL } from '../src/wal.js';

interface MockHandle {
  read?: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  write?: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
  sync?: () => Promise<void>;
  close?: () => Promise<void>;
}

// Every patched property is recorded with its original value; the afterEach
// restores them in reverse order. This replaces vitest's
// doMock/doUnmock/resetModules, which has no Bun equivalent: importers hold the
// shared module object, so swapping a property is enough — and unlike
// mock.module it can be undone.
const restores: (() => void)[] = [];

function patch(owner: object, key: string, value: unknown): void {
  const target = owner as unknown as Record<string, unknown>;
  const original = target[key];
  target[key] = value;
  restores.push(() => {
    target[key] = original;
  });
}

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

// Replace the `open` compaction.ts consumes through its default import
// (`import fs from 'node:fs/promises'`).
function mockFsPromises(open: (path: string, flags?: string) => Promise<MockHandle>): void {
  patch(fs, 'open', open as unknown as typeof fs.open);
}

test('copyFileRange throws when the destination short-writes (bytesWritten === 0)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      // Source claims to have produced bytes so the loop reaches write().
      return { read: async () => ({ bytesRead: 16 }), close: async () => {} };
    }
    // Destination makes no progress → the short-write guard fires.
    return {
      write: async () => ({ bytesWritten: 0 }),
      sync: async () => {},
      close: async () => {},
    };
  });
  await expect((() => copyFileRange('/tmp/src', '/tmp/dst', 0, 16))()).rejects.toThrow(/short write/);
});

test('copyFileRange tolerates a source close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return {
        read: async (buf: unknown) => {
          (buf as Buffer)[0] = 0xab;
          return { bytesRead: 1 };
        },
        close: async () => {
          throw new Error('source close failed');
        },
      };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {},
    };
  });
  // The source close failure is swallowed; the copy itself succeeds.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 1)).resolves.toBeUndefined();
});

test('copyFileRange tolerates a destination close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return { read: async () => ({ bytesRead: 0 }), close: async () => {} };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {
        throw new Error('dest close failed');
      },
    };
  });
  // Empty range (start===end) → no writes, only a dst.sync() then a failing
  // dst.close() that must be swallowed.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 0)).resolves.toBeUndefined();
});

test('fsyncDir strict mode propagates a sync() failure and still closes the handle', async () => {
  let closed = false;
  mockFsPromises(async () => ({
    sync: async () => {
      throw new Error('sync failed');
    },
    close: async () => {
      closed = true;
    },
  }));
  await expect(fsyncDir('/tmp/whatever', { strict: true })).rejects.toThrow(/sync failed/);
  expect(closed, 'close() is called even after sync() throws').toBe(true);
});

test('fsyncDir marks unsupported directory fsync and continues without logging', async () => {
  mockFsPromises(async () => ({
    sync: async () => {
      throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
    },
    close: async () => {},
  }));
  expect(isUnsupportedDirectoryFsyncError('EPERM', 'win32')).toBe(true);
  expect(isUnsupportedDirectoryFsyncError('EPERM', 'linux')).toBe(false);
  const stats: { dirFsyncUnsupported?: boolean } = {};
  // Even strict mode does NOT reject on unsupported directory fsync errors:
  // POSIX commonly reports EINVAL/ENOTSUP, while Windows reports EPERM.
  await fsyncDir('/tmp/whatever', { strict: true, stats });
  expect(stats.dirFsyncUnsupported).toBe(true);
  await fsyncDir('/tmp/whatever', { strict: true, stats });
  expect(stats.dirFsyncUnsupported).toBe(true);
});

test('fsyncDir non-strict mode keeps swallowing ordinary failures (legacy callers)', async () => {
  let closed = false;
  mockFsPromises(async () => ({
    sync: async () => {
      throw new Error('sync failed');
    },
    close: async () => {
      closed = true;
    },
  }));
  await expect(fsyncDir('/tmp/whatever')).resolves.toBeUndefined();
  expect(closed).toBe(true);
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-rotation-fault-'));
}

// Passthrough node:fs/promises patch for the rotation-level tests: everything
// delegates to the real functions, except operations whose fault callback
// returns an error — that error is thrown instead of delegating. Lets a test
// fail ONE rotation step (a specific rename, one append-handle open)
// deterministically while the rest of MiniDb keeps using the real filesystem.
function mockFsWithFaults(faults: {
  rename?: (src: string, dst: string) => Error | null;
  open?: (path: string, flags: string | number | undefined) => Error | null;
}): void {
  const realRename = fs.rename;
  const realOpen = fs.open;
  patch(
    fs,
    'rename',
    (async (src: PathLike, dst: PathLike): Promise<void> => {
      const err = faults.rename?.(String(src), String(dst));
      if (err) throw err;
      await realRename(src, dst as never);
    }) as typeof fs.rename,
  );
  patch(
    fs,
    'open',
    (async (p: PathLike, flags?: string | number, mode?: string | number) => {
      const err = faults.open?.(String(p), flags);
      if (err) throw err;
      return realOpen(p, flags as string | number | undefined, mode as never);
    }) as typeof fs.open,
  );
}

// Passthrough node:fs/promises patch that breaks the sync() of the db
// DIRECTORY handle on the chosen open calls — the rotation's two fsyncDir
// calls are the only directory syncs in the system, so counting directory
// opens targets "the first/second dir fsync of the first compaction"
// deterministically.
function mockFsWithDirSyncFault(dir: string, failOnCalls: ReadonlySet<number>): void {
  const realOpen = fs.open;
  let dirOpens = 0;
  patch(
    fs,
    'open',
    (async (p: PathLike, flags?: string | number, mode?: string | number) => {
      const h = await realOpen(p, flags as string | number | undefined, mode as never);
      if (String(p) === dir && flags === 'r') {
        dirOpens++;
        if (failOnCalls.has(dirOpens)) {
          h.sync = async () => {
            throw Object.assign(new Error('injected dir fsync failure'), { code: 'EIO' });
          };
        }
      }
      return h;
    }) as typeof fs.open,
  );
}

test('wal.close() propagates a final-sync failure but still releases the file handle', async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'db.wal');
    const wal = new WAL(file, { fsyncPolicy: 'no' }); // 'no': no background sync timer
    await wal.open();
    await wal.append(
      encodeFrame({ type: TYPE_SET, key: Buffer.from('a'), value: Buffer.from('1') }),
    );

    const origSync = wal.sync.bind(wal);
    wal.sync = async () => {
      wal.sync = origSync; // one-shot
      throw new Error('injected fsync failure');
    };
    await expect(wal.close()).rejects.toThrow(/injected fsync failure/);
    // The failed close still released the handle (compaction's recovery swap
    // abandons this WAL object and must not leak its fd)...
    expect((wal as unknown as { fh: unknown }).fh).toBe(null);
    // ...the WAL stays closed...
    await wal.close();
    // ...and the flushed frame stayed durable, so a fresh WAL — which is what
    // rotation recovery swaps in — continues the same file at the real EOF.
    const fresh = new WAL(file, { fsyncPolicy: 'no' });
    await fresh.open();
    expect(fresh.size > 0).toBeTruthy();
    await fresh.append(
      encodeFrame({ type: TYPE_SET, key: Buffer.from('b'), value: Buffer.from('2') }),
    );
    await fresh.close();

    const frames = [...new FrameParser().feed(await fs.readFile(file))];
    expect(frames.map((f) => f.key.toString())).toStrictEqual(['a', 'b']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a WAL close() failure leaves the db writable and compact() retries cleanly', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
      indexGenerations: false,
    });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    const wal = db.wal;
    let parked: Promise<void> | undefined;
    const origClose = wal.close.bind(wal);
    wal.close = async () => {
      wal.close = origClose; // one-shot
      // Inside the rotation the old WAL is already sealed and _rotateLock is
      // held: a write issued now parks on the lock and must still succeed once
      // the failed rotation has recovered.
      parked = db.set('parked', 'during-failed-rotation');
      throw new Error('injected close failure');
    };
    await expect(db.compact()).rejects.toThrow(/injected close failure/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);
    expect(String(String(db.lastCompactError))).toMatch(/injected close failure/);

    // The parked write and every later write hit the recovered (swapped-in)
    // WAL, not the sealed/closed old one.
    await parked;
    await db.set('post', 'still-writable');
    expect(db.get('parked')).toBe('during-failed-rotation');
    expect(db.get('post')).toBe('still-writable');

    // An explicit compact() retries cleanly after the failed rotation.
    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.lastCompactError).toBe(null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    expect(db.size).toBe(N + 2);
    expect(db.get('k0')).toBe('v0');
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('parked')).toBe('during-failed-rotation');
    expect(db.get('post')).toBe('still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a WAL rename failure (new snapshot already in place) leaves the db writable', async () => {
  let armed = true;
  mockFsWithFaults({
    rename: (src, dst) => {
      // Fail only the first db.wal.tmp → db.wal rename: by then the new
      // snapshot has already been renamed into place, so this exercises the
      // trickiest partial-rotation state (new snapshot + old full WAL).
      if (armed && src.endsWith('db.wal.tmp') && dst.endsWith('db.wal')) {
        armed = false;
        return Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return null;
    },
  });
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
      indexGenerations: false,
    });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    await expect(db.compact()).rejects.toThrow(/injected rename failure/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);

    await db.set('post', 'still-writable');
    expect(db.get('k0')).toBe('v0');
    expect(db.get('post')).toBe('still-writable');

    // An explicit compact() retries cleanly on top of the partial rotation.
    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.lastCompactError).toBe(null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    expect(db.size).toBe(N + 1);
    expect(db.get('k0')).toBe('v0');
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('post')).toBe('still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a new-WAL open() failure after the renames leaves the db writable', async () => {
  let canArm = true;
  let armOpenFault = false;
  mockFsWithFaults({
    rename: (src, dst) => {
      // Arm the open fault once the FIRST WAL rename has landed, so it hits
      // the first append-handle open afterwards — the fresh WAL's open()
      // inside the rotation. Later compactions must re-arm nothing.
      if (canArm && src.endsWith('db.wal.tmp') && dst.endsWith('db.wal')) {
        canArm = false;
        armOpenFault = true;
      }
      return null;
    },
    open: (p, flags) => {
      if (armOpenFault && flags === 'a' && p.endsWith('db.wal')) {
        armOpenFault = false;
        return Object.assign(new Error('injected open failure'), { code: 'EMFILE' });
      }
      return null;
    },
  });
  const dir = await tmpDir();
  try {
    const opts = {
      dir,
      valueCodec: 'string' as const,
      valueMode: 'disk' as const,
      fsyncPolicy: 'no' as const,
      compactThresholdBytes: 1 << 30,
    };
    let db = await MiniDb.open<string>(opts);
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    await expect(db.compact()).rejects.toThrow(/injected open failure/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);

    // The renames had already committed the new snapshot/WAL layout when the
    // open failed, so recovery also applied the store-pointer remap.
    const sawSnapshotRef = [...db.store.map.values()].some(
      (r) => r.ref.kind === 'disk' && r.ref.loc.file === 'snapshot',
    );
    expect(sawSnapshotRef, 'store pointers were remapped to the new snapshot after the failed rotation').toBeTruthy();

    // Disk-backed reads stay correct and the db is writable again.
    expect(db.get('k0')).toBe('v0');
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    await db.set('post', 'still-writable');
    expect(db.get('post')).toBe('still-writable');

    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.get('k42')).toBe('v42');
    await db.close();

    db = await MiniDb.open<string>(opts);
    expect(db.size).toBe(N + 1);
    expect(db.get('k0')).toBe('v0');
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('post')).toBe('still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: the first directory fsync failure aborts the rotation; rollback + consistent disk pairing', async () => {
  const dir = await tmpDir();
  // Fail the rotation's FIRST dir fsync (after the snapshot rename, before
  // the WAL rename).
  mockFsWithDirSyncFault(dir, new Set([1]));
  try {
    let db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
      indexGenerations: false,
    });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    // The strict fsyncDir turns the failure into an abort, not a swallow.
    await expect(db.compact()).rejects.toThrow(/injected dir fsync failure/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);
    expect(String(String(db.lastCompactError))).toMatch(/injected dir fsync failure/);
    expect(db.stats.dirFsyncUnsupported, 'an I/O error is not the platform-degrade path').not.toBe(true);

    // The abort went through the existing rollback: the write path is back.
    await db.set('post', 'still-writable');
    expect(db.get('k0')).toBe('v0');
    expect(db.get('post')).toBe('still-writable');

    // The rotation died right after the snapshot rename: the disk holds the
    // NEW snapshot paired with the OLD full WAL — the crash-safe intermediate
    // pairing, which a fresh open recovers completely.
    const probe = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    expect(probe.size, 'new snapshot + old full WAL is a consistent complete pairing').toBe(N + 1);
    expect(probe.get('k0')).toBe('v0');
    expect(probe.get('post')).toBe('still-writable');
    await probe.close();

    // The fault was one-shot: an explicit retry compacts cleanly.
    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.lastCompactError).toBe(null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    expect(db.size).toBe(N + 1);
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('post')).toBe('still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: the second directory fsync failure aborts after both renames; rollback + consistent disk pairing', async () => {
  const dir = await tmpDir();
  // Fail the rotation's SECOND dir fsync (after the WAL rename — the new
  // layout is already on disk).
  mockFsWithDirSyncFault(dir, new Set([2]));
  try {
    let db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
      indexGenerations: false,
    });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    await expect(db.compact()).rejects.toThrow(/injected dir fsync failure/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);
    expect(String(String(db.lastCompactError))).toMatch(/injected dir fsync failure/);

    // The write path recovered through the rotation-failure rollback.
    await db.set('post', 'still-writable');
    expect(db.get('k0')).toBe('v0');
    expect(db.get('post')).toBe('still-writable');

    // Both renames had landed when the second fsync failed: the disk holds
    // the NEW snapshot + NEW WAL — the complete new generation.
    const probe = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    expect(probe.size, 'new snapshot + new WAL is the complete new generation').toBe(N + 1);
    expect(probe.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(probe.get('post')).toBe('still-writable');
    await probe.close();

    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.lastCompactError).toBe(null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    expect(db.size).toBe(N + 1);
    expect(db.get('k0')).toBe('v0');
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('post')).toBe('still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a compaction whose onCompacted hook throws counts as a compactError, not a compaction', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
    });
    for (let i = 0; i < 50; i++) await db.set(`k${i}`, `v${i}`);

    const hook = db.onCompacted;
    let failHook = true;
    db.onCompacted = async () => {
      if (failHook) throw new Error('injected hook failure');
      await hook();
    };
    await expect(db.compact()).rejects.toThrow(/injected hook failure/);
    // The hook is part of the compaction: compactions counts only fully
    // successful runs, even though the rotation itself had already succeeded.
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);
    expect(String(String(db.lastCompactError))).toMatch(/injected hook failure/);

    // The rotation succeeded, so the db keeps working normally.
    await db.set('post', 'ok');
    expect(db.size).toBe(51);

    failHook = false;
    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.lastCompactError).toBe(null);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a WAL poison during the snapshot phase aborts this compaction; the next compaction succeeds and data stays consistent', async () => {
  // Barrier-driven: the snapshot phase parks on `releaseSnapshot`, and the
  // in-place recovery's fs.truncate parks on `releaseTruncate`, so the
  // compaction deterministically hits the poisoned WAL (its pre-copy flush
  // throws) before the recovery can clear the poison.
  let snapshotEntered!: () => void;
  let releaseSnapshot!: () => void;
  const entered = new Promise<void>((r) => (snapshotEntered = r));
  const releaseS = new Promise<void>((r) => (releaseSnapshot = r));
  // snapshot.writeSnapshot is spied on the real ESM namespace (Bun has no
  // importActual): the real implementation runs once the gate opens.
  const realWriteSnapshot = snapshot.writeSnapshot;
  const writeSnapshotSpy = spyOn(snapshot, 'writeSnapshot').mockImplementation(
    async (...args: Parameters<typeof realWriteSnapshot>) => {
      snapshotEntered();
      await releaseS;
      return realWriteSnapshot(...args);
    },
  );
  restores.push(() => writeSnapshotSpy.mockRestore());
  let releaseTruncate!: () => void;
  const truncateGate = new Promise<void>((r) => (releaseTruncate = r));
  const realTruncate = fs.truncate;
  patch(
    fs,
    'truncate',
    (async (p: PathLike, len?: number): Promise<void> => {
      await truncateGate;
      return realTruncate(p, len as never);
    }) as typeof fs.truncate,
  );

  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      compactThresholdBytes: 1 << 30,
      indexGenerations: false,
    });
    const N = 50;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    const compactPromise = db.compact();
    await entered; // the compaction is parked inside the snapshot phase now

    // Poison the WAL with a one-shot writev failure.
    const fh = (db as unknown as { wal: { fh: { writev: (...a: unknown[]) => Promise<unknown> } } })
      .wal.fh;
    const orig = fh.writev.bind(fh);
    let boom = true;
    fh.writev = async (...a: unknown[]) => {
      if (boom) {
        boom = false;
        throw new Error('injected WAL failure');
      }
      return orig(...a);
    };
    await expect(db.set('bad', 'x')).rejects.toThrow(/injected WAL failure/);

    // The compaction's next flush hits the poison and aborts the whole round
    // through its existing catch (the recovery's truncate is still gated).
    releaseSnapshot();
    await expect(compactPromise).rejects.toThrow(/poisoned/);
    expect(db.stats.compactions).toBe(0);
    expect(db.stats.compactErrors).toBe(1);

    // Let the in-place recovery run; later writes queue behind it. Then the
    // next compaction round succeeds on the truncated WAL.
    releaseTruncate();
    await db.set('post', 'ok');
    await db.compact();
    expect(db.stats.compactions).toBe(1);
    expect(db.stats.compactErrors).toBe(1);
    expect(db.get('bad'), 'the rejected write never reached the snapshot or the WAL').toBe(undefined);
    expect(db.get('k0')).toBe('v0');
    expect(db.get('post')).toBe('ok');
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    expect(db.size).toBe(N + 1);
    expect(db.get('bad')).toBe(undefined);
    expect(db.get(`k${N - 1}`)).toBe(`v${N - 1}`);
    expect(db.get('post')).toBe('ok');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
