import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/recovery.test.ts
import { expect, afterEach, test } from 'bun:test';

import { HEADER_SIZE, CRC_SIZE, encodeFrame, TYPE_SET } from '../src/codec.js';
import { MiniDb } from '../src/index.js';
import { ValueReader } from '../src/value-reader.js';

// Faults are injected by patching the real node:fs / node:fs/promises exports
// object — every minidb module default-imports that same object, so a swap
// reaches recovery/value-reader without re-importing anything (vitest did this
// with doMock + resetModules, which Bun has no equivalent for). The afterEach
// restores every patched property.
const restores: (() => void)[] = [];

function patch(owner: object, key: string, value: unknown): void {
  const target = owner as unknown as Record<string, unknown>;
  const original = target[key];
  target[key] = value;
  restores.push(() => {
    target[key] = original;
  });
}

/** Undo every patch installed since the last call: a test that needs the REAL
 *  filesystem again mid-test (a clean reopen after the injected fault) calls
 *  this explicitly. */
function restorePatches(): void {
  while (restores.length > 0) restores.pop()!();
}

afterEach(() => {
  restorePatches();
});

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-recover-'));
}

// Each record: key='kN'(2B), value='vN'(2B), no meta -> 22+2+2+0+4 = 30 bytes
const FRAME = HEADER_SIZE + 2 + 2 + 0 + CRC_SIZE;

async function writeFive(dir) {
  const db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    fsyncPolicy: 'always',
    autoCompact: false,
  });
  for (let i = 0; i < 5; i++) await db.set(`k${i}`, `v${i}`);
  await db.close();
}

test('resync: a single corrupt frame mid-file only loses that frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    expect(buf.length).toBe(FRAME * 5);

    // Corrupt k2's value (frame at offset 2*FRAME; value starts after header+key).
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff;
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'resync' });
    expect(db.recoveryInfo.corruptRanges.length).toBe(1);
    expect(db.recoveryInfo.corruptRanges[0]).toStrictEqual([2 * FRAME, 3 * FRAME]);
    expect(db.recoveryInfo.lostBytes).toBe(FRAME);

    // k2 lost, everything else recovered.
    expect(db.get('k0')).toBe('v0');
    expect(db.get('k1')).toBe('v1');
    expect(db.get('k2')).toBe(undefined);
    expect(db.get('k3')).toBe('v3');
    expect(db.get('k4')).toBe('v4');
    expect(db.size).toBe(4);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: multiple corrupt frames are each skipped', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[1 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k1
    buf[3 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k3
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.recoveryInfo.corruptRanges.length).toBe(2);
    expect([
        ...new Set(['k0', 'k1', 'k2', 'k3', 'k4'].filter((k) => db.get(k) !== undefined)),
      ].toSorted()).toStrictEqual(['k0', 'k2', 'k4']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: torn tail is still truncated', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const valid = await fs.readFile(walPath);
    // append a half-written frame
    await fs.appendFile(walPath, valid.subarray(0, 11));

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    expect(db.recoveryInfo.truncatedWal).toBe(true);
    expect(db.size).toBe(5);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('strict mode truncates at the first bad frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff; // corrupt k2
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'strict' });
    // strict recovers k0,k1 then stops at k2; k3,k4 are NOT recovered.
    expect(db.get('k0')).toBe('v0');
    expect(db.get('k1')).toBe('v1');
    expect(db.size).toBe(2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// catchUpFromWal: a read-only replica applies only the WAL frames appended
// after its watermark; the result must be identical to a from-scratch replay
// (store, dt, compound, secondary, unique and text indexes alike).
for (const valueMode of ['memory', 'disk'] as const) {
  test(
    `catchUpFromWal (${valueMode}): mixed tail applies identically to a full reopen`,
    { timeout: 60_000 },
    async () => {
      const dir = await tmpDir();
      try {
        const doc = (i: number) => ({
          n: i,
          c: `c${i % 7}`,
          u: `u${i}`,
          t: `alpha beta w${i % 13}`,
        });
        const writer = await MiniDb.open<Record<string, unknown>>({
          dir,
          valueCodec: 'json',
          valueMode,
          fsyncPolicy: 'no',
          autoCompact: false,
        });
        await writer.createIndex('c', { field: 'c' });
        await writer.createIndex('n', { field: 'n', type: 'range' });
        await writer.createIndex('u', { field: 'u', unique: true });
        await writer.createTextIndex('t', { fields: ['t'] });
        await writer.createCompoundIndex('cg', { groupBy: 'c', orderBy: 'n' });
        for (let i = 0; i < 2000; i++)
          await writer.set(`pre:${i}`, doc(i), { dt: { created: 1700000000000 + i } });

        const reader = await MiniDb.open<Record<string, unknown>>({
          dir,
          valueCodec: 'json',
          valueMode,
          readOnly: true,
        });
        const ri = reader.recoveryInfo!;
        expect(ri.walScanEnd > 0).toBeTruthy();
        expect(ri.walIno !== 0).toBeTruthy();

        // Mixed storm: updates, new sets, dels, one BATCH frame, short/long TTL,
        // dt-only change. 500 + 500 + 300 + 1 + 2 = 1303 appended frames.
        for (let i = 1500; i < 2000; i++) {
          await writer.set(
            `pre:${i}`,
            { ...doc(i), n: i * 10, t: `alpha changed w${i % 13}` },
            { dt: { created: 1700000009000 + i } },
          );
        }
        for (let i = 0; i < 500; i++)
          await writer.set(
            `s:${i}`,
            { ...doc(i), u: `us${i}` },
            { dt: { created: 1700001000000 + i } },
          );
        for (let i = 0; i < 1500; i += 5) await writer.del(`pre:${i}`);
        await writer.batch([
          { op: 'set', key: 's:b1', value: doc(9001), dt: { created: 1700002000000 } },
          { op: 'set', key: 's:b2', value: { ...doc(9002), t: 'alpha batch' } },
          { op: 'del', key: 's:b1' },
        ]);
        await writer.set('s:short', doc(9100), { ttl: 1 });
        await writer.set('s:long', doc(9101), { ttl: 3_600_000 });

        const res = await reader.catchUpFromWal(ri.walScanEnd);
        expect(res, 'clean watermark must catch up').toBeTruthy();
        expect(res.appliedFrames).toBe(1303);
        expect(res.offset > ri.walScanEnd).toBeTruthy();

        // Reference: a full from-scratch replay of the same files.
        const ref = await MiniDb.open<Record<string, unknown>>({
          dir,
          valueCodec: 'json',
          valueMode,
          readOnly: true,
        });
        const sortByKey = (a: { key: string }, b: { key: string }): number =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        expect(reader.size).toBe(ref.size);
        expect(reader.scan()).toStrictEqual(ref.scan());
        expect(reader.dtColumns()).toStrictEqual(ref.dtColumns());
        expect(reader.findEq('c', 'c3').toSorted(sortByKey)).toStrictEqual(ref.findEq('c', 'c3').toSorted(sortByKey));
        expect(reader.findEq('u', 'u1700')).toStrictEqual(ref.findEq('u', 'u1700'));
        expect(reader.findRange('n', { min: 100, max: 500 }).toSorted(sortByKey)).toStrictEqual(ref.findRange('n', { min: 100, max: 500 }).toSorted(sortByKey));
        expect(reader.dtRange('created', { gte: 1700000009000, limit: 20 })).toStrictEqual(ref.dtRange('created', { gte: 1700000009000, limit: 20 }));
        expect(reader.compoundRange('cg', 'c2', { limit: 25 })).toStrictEqual(ref.compoundRange('cg', 'c2', { limit: 25 }));
        expect(reader.search('t', 'alpha')).toStrictEqual(ref.search('t', 'alpha'));
        expect(reader.search('t', 'changed')).toStrictEqual(ref.search('t', 'changed'));
        expect(reader.search('t', 'batch')).toStrictEqual(ref.search('t', 'batch'));
        expect(reader.get('s:short')).toBe(undefined);
        expect(ref.get('s:short')).toBe(undefined);
        expect(reader.get('s:long')).toStrictEqual(ref.get('s:long'));

        // No new writes: catch-up is a cheap no-op at the same offset.
        expect(await reader.catchUpFromWal(res.offset)).toStrictEqual({
          offset: res.offset,
          appliedFrames: 0,
        });
        // Not a frame boundary (byte 3 of the first frame's header: flags=0).
        expect(await reader.catchUpFromWal(3)).toBe(null);

        await ref.close();
        await reader.close();
        await writer.close();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
}

test('catchUpFromWal: a torn tail pauses the catch-up and a later call completes it', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 10; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;

    // Simulate a writer mid-writev: only a PREFIX of the next frame is on
    // disk. The catch-up must stop at the last fully-valid frame without
    // erroring, and must not advance the watermark past it.
    const frame = encodeFrame({
      type: TYPE_SET,
      key: Buffer.from('torn', 'utf8'),
      value: Buffer.from(JSON.stringify({ n: 99 }), 'utf8'),
    });
    const half = Math.floor(frame.length / 2);
    const walPath = path.join(dir, 'db.wal');
    await fs.appendFile(walPath, frame.subarray(0, half));
    const paused = await reader.catchUpFromWal(ri.walScanEnd);
    expect(paused).toStrictEqual({ offset: ri.walScanEnd, appliedFrames: 0 });
    expect(reader.get('torn')).toBe(undefined);

    // The writev lands: the tail's CRC now validates and the frame applies.
    await fs.appendFile(walPath, frame.subarray(half));
    const done = await reader.catchUpFromWal(ri.walScanEnd);
    expect(done).toStrictEqual({ offset: ri.walScanEnd + frame.length, appliedFrames: 1 });
    expect(reader.get('torn')).toStrictEqual({ n: 99 });

    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: an in-place truncate + rewrite below the watermark is declined', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    // One frame well past the tail fingerprint window, so the region below the
    // replica's watermark shares no bytes with the rewrite.
    await writer.set('pre:0', { pad: 'A'.repeat(8192) });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    const walPath = path.join(dir, 'db.wal');
    expect(ri.walScanEnd > 4096, 'the scanned WAL is longer than the fingerprint window').toBeTruthy();
    expect(ri.walScanTail, 'recovery anchors the replica on a WAL content fingerprint').toBeTruthy();

    // The writer's WAL is poisoned (e.g. ENOSPC mid-batch): recoverWalInPlace
    // truncates db.wal to the poison's failedAtOffset ON THE SAME INODE, and the
    // reopened writer writes new frames back over [T, replica watermark). Here
    // that prefix is replaced with different bytes of the same length and fresh
    // frames are appended, so the file GROWS past the replica's watermark and
    // the bytes AT the watermark start a perfectly valid frame: the old
    // frame-boundary + size guards would happily continue and apply a history
    // the replica never saw.
    const frame = (key: string, value: unknown): Buffer =>
      encodeFrame({
        type: TYPE_SET,
        key: Buffer.from(key, 'utf8'),
        value: Buffer.from(JSON.stringify(value), 'utf8'),
      });
    const ghost = frame('ghost', { n: 1 });
    const rewritten = frame('rewritten', { n: 2, pad: 'B'.repeat(8192) });
    await writer.wal.flush();
    await fs.writeFile(
      walPath,
      Buffer.concat([Buffer.alloc(ri.walScanEnd, 0x42), ghost, rewritten]),
    );

    const st = await fs.stat(walPath);
    expect(st.ino, 'same inode: the rewrite is in place, not a rotation').toBe(ri.walIno);
    expect(st.size > ri.walScanEnd, 'size alone says "append", which is the trap').toBeTruthy();
    const fh = await fs.open(walPath, 'r');
    try {
      const head = Buffer.alloc(2);
      await fh.read(head, 0, 2, ri.walScanEnd);
      expect(head, 'the bytes at the watermark do start a valid frame').toStrictEqual(MAGIC);
    } finally {
      await fh.close();
    }

    // Only the content fingerprint can falsify the continuation: the catch-up
    // must decline, leave the already-applied state untouched, and hand the
    // reopen decision to the caller.
    expect(await reader.catchUpFromWal(ri.walScanEnd)).toBe(null);
    expect(reader.get('ghost'), 'no frame rewritten below the watermark applies').toBe(undefined);
    expect(reader.get('rewritten'), 'the appended rewrite is not applied either').toBe(undefined);
    expect(reader.get('pre:0'), 'the already-applied state stays untouched').toBeTruthy();

    // Reference: a full reopen replays exactly the rewritten history.
    await reader.close();
    const ref = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    expect(ref.get('ghost')).toStrictEqual({ n: 1 });
    expect(ref.get('rewritten')).toStrictEqual({ n: 2, pad: 'B'.repeat(8192) });
    await ref.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: a compaction rotation swaps the WAL inode and the catch-up declines', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 100; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    expect(ri.walScanEnd > 0).toBeTruthy();

    // Rotation: compaction swaps db.snapshot/db.wal in two renames, so the
    // WAL the reader anchored on is gone — incremental catch-up must decline
    // (null) and leave the reopen decision to the caller.
    await writer.compact();
    expect(await reader.catchUpFromWal(ri.walScanEnd)).toBe(null);

    // A fresh read-only reopen sees every write, including post-rotation ones.
    await writer.set('post-rotation', { n: 101 });
    await reader.close();
    const reopened = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    expect(reopened.size).toBe(101);
    expect(reopened.get('post-rotation')).toStrictEqual({ n: 101 });
    await reopened.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catchUpFromWal: concurrent calls are serialized instead of interleaving mid-apply', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, { n: i });
    const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
    const ri = reader.recoveryInfo!;
    for (let i = 50; i < 150; i++) await writer.set(`k${i}`, { n: i });

    // The sliced async apply yields to the event loop, so two overlapping
    // catch-ups at the same watermark would interleave op-by-op without the
    // per-instance chain. The second call runs after the first advanced the
    // watermark and declines (the caller then falls back to a reopen).
    const [first, second] = await Promise.all([
      reader.catchUpFromWal(ri.walScanEnd),
      reader.catchUpFromWal(ri.walScanEnd),
    ]);
    expect(first && first.appliedFrames === 100).toBeTruthy();
    expect(second).toBe(null);
    expect(reader.size).toBe(150);

    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  'catchUpFromWal: a large tail applies in cooperative slices (event loop stays live)',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir();
    try {
      const writer = await MiniDb.open({
        dir,
        valueCodec: 'json',
        fsyncPolicy: 'no',
        autoCompact: false,
      });
      for (let i = 0; i < 100; i++) await writer.set(`pre:${i}`, { n: i, t: `alpha ${i}` });
      await writer.createTextIndex('t', { fields: ['t'] });
      const reader = await MiniDb.open({ dir, valueCodec: 'json', readOnly: true });
      const ri = reader.recoveryInfo!;
      // 8000 single-op frames: WAL_APPLY_OPS_PER_SLICE (512) alone forces ~15
      // yields mid-apply even when every op is cheap.
      for (let i = 0; i < 8000; i++) await writer.set(`s:${i}`, { n: i, t: `alpha beta ${i}` });

      // Count event-loop turns observed while the catch-up runs. The async
      // scan contributes about one (a sub-window file fills in one read); an
      // UNSLICED apply would add none, the sliced one adds one per 512 ops.
      let loopTurns = 0;
      let catchUpDone = false;
      const probe = (async () => {
        for (;;) {
          await new Promise((r) => setImmediate(r));
          if (catchUpDone) return;
          loopTurns++;
        }
      })();
      const res = await reader.catchUpFromWal(ri.walScanEnd);
      catchUpDone = true;
      await probe;

      expect(res && res.appliedFrames === 8000).toBeTruthy();
      expect(loopTurns >= 3, `expected the sliced apply to yield repeatedly, observed ${loopTurns} loop turn(s)`).toBeTruthy();
      expect(reader.size).toBe(8100);
      expect(reader.search('t', 'beta').length > 0).toBeTruthy();

      await reader.close();
      await writer.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

// ---- generation pairing (stat-pairing; review #15) --------------------------
//
// Fault-injection tests for recover()'s snapshot/WAL generation pairing. The
// injections run INSIDE patched fs calls, which makes them deterministic: they
// fire exactly at recover's forensic points (the post-scan path re-stat, the
// ValueReader attach) — no sleeps, no races. Each patch wraps the real
// node:fs function the sources already hold, so seeding and verification keep
// working, and the afterEach restores the real fs.

type FsSyncModule = typeof import('node:fs');

/** Patch node:fs so statSync/openSync on the db.wal path fire the given hook
 *  (with the call count) before delegating to the real function. Everything
 *  else passes through untouched. */
function mockFsSyncForWal(
  walPath: string,
  hooks: {
    onStatSync?: (call: number, real: FsSyncModule) => void;
    onOpenSync?: (call: number, real: FsSyncModule) => void;
  },
): void {
  const real = fsSync;
  const realStatSync = fsSync.statSync;
  const realOpenSync = fsSync.openSync;
  let statCalls = 0;
  let openCalls = 0;
  patch(
    fsSync,
    'statSync',
    ((p: unknown, ...args: unknown[]) => {
      if (String(p) === walPath) hooks.onStatSync?.(++statCalls, real);
      return (realStatSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fsSync.statSync,
  );
  patch(
    fsSync,
    'openSync',
    ((p: unknown, ...args: unknown[]) => {
      if (String(p) === walPath) hooks.onOpenSync?.(++openCalls, real);
      return (realOpenSync as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fsSync.openSync,
  );
}

/** Atomically replace db.wal with an identical-content copy on a NEW inode —
 *  exactly what a compaction rotation's rename does. */
function swapWalInodeSync(real: FsSyncModule, walPath: string): void {
  real.copyFileSync(walPath, `${walPath}.swap`);
  real.renameSync(`${walPath}.swap`, walPath);
}

// The WAL inode swap is simulated with POSIX rename-over-open semantics,
// which Windows cannot reproduce (an open WAL handle blocks rename/unlink).
test.skipIf(process.platform === 'win32')(
  'generation pairing: a rotation-like WAL inode swap at the post-scan forensics is retried to a consistent read-only open',
  async () => {
    const dir = await tmpDir();
    try {
      const writer = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        fsyncPolicy: 'no',
        autoCompact: false,
        indexGenerations: false,
      });
      for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);

      // The injection fires when recover takes its post-scan path stat of
      // db.wal (forensics round 2): the WAL is swapped for a new inode between
      // the scan and the verification — precisely the rotation race the
      // pairing exists to catch. One-shot: the retried pass sees a stable pair.
      const walPath = path.join(dir, 'db.wal');
      let swaps = 0;
      mockFsSyncForWal(walPath, {
        onStatSync: (call, real) => {
          if (call === 1) {
            swapWalInodeSync(real, walPath);
            swaps++;
          }
        },
      });
      const reader = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        readOnly: true,
        indexGenerations: false,
      });
      expect(swaps).toBe(1);
      expect(reader.recoveryInfo!.generationRetries, 'the swapped inode forced exactly one retry').toBe(1);
      expect(reader.size).toBe(50);
      expect(reader.get('k0')).toBe('v0');
      expect(reader.get('k49')).toBe('v49');
      await reader.close();
      await writer.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('generation pairing: churn beyond the retry budget throws RECOVERY_GENERATION_CHURN and leaves no partial state', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
      indexGenerations: false,
    });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // EVERY pass's post-scan stat swaps the WAL inode: recovery can never
    // pair a consistent set and must exhaust its bounded retries (1 + 4).
    const walPath = path.join(dir, 'db.wal');
    let swaps = 0;
    mockFsSyncForWal(walPath, {
      onStatSync: (_call, real) => {
        swapWalInodeSync(real, walPath);
        swaps++;
      },
    });
    const churn = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      readOnly: true,
      indexGenerations: false,
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; name?: string },
    );
    expect(churn?.code).toBe('RECOVERY_GENERATION_CHURN');
    expect(churn?.name).toBe('RecoveryGenerationChurnError');
    expect(swaps, 'one swap per pass: the initial attempt plus 4 retries').toBe(5);

    // No partial application state survived the failed open: the swaps
    // preserved content, and a clean open recovers every key (with the real fs
    // restored, so the WAL stays stable).
    restorePatches();
    const db = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    expect(db.size).toBe(50);
    expect(db.get('k0')).toBe('v0');
    expect(db.get('k49')).toBe('v49');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing: append-only WAL growth between the forensic rounds does not trigger a retry', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
      indexGenerations: false,
    });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // A live writer's append landing between recover's scan and its post-scan
    // stat (same inode, size grew) is the safe staleness window — NOT a
    // generation switch — and must not cost a retry.
    const walPath = path.join(dir, 'db.wal');
    mockFsSyncForWal(walPath, {
      onStatSync: (call, real) => {
        if (call === 1) {
          real.appendFileSync(
            walPath,
            encodeFrame({ type: TYPE_SET, key: Buffer.from('late'), value: Buffer.from('z') }),
          );
        }
      },
    });
    const reader = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      readOnly: true,
      indexGenerations: false,
    });
    expect(reader.recoveryInfo!.generationRetries, 'append-only growth must not be retried').toBe(0);
    expect(reader.size).toBe(50);
    // The late frame landed after the scan: outside the recovered view, to be
    // picked up by a later catch-up instead.
    expect(reader.get('late')).toBe(undefined);
    expect(reader.get('k49')).toBe('v49');
    await reader.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing (disk mode): a ValueReader attach to the wrong inode retries the whole recovery', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.close();

    // The swap fires when the ValueReader opens db.wal to attach (the second
    // openSync: the first was recovery's scan) — after recovery's forensics
    // verified the old inode. The attach check must reject the mismatched
    // handle and retry the whole recovery against the new generation.
    const walPath = path.join(dir, 'db.wal');
    let swaps = 0;
    mockFsSyncForWal(walPath, {
      onOpenSync: (call, real) => {
        if (call === 2) {
          swapWalInodeSync(real, walPath);
          swaps++;
        }
      },
    });
    const reader = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      readOnly: true,
      indexGenerations: false,
    });
    expect(swaps).toBe(1);
    expect(reader.recoveryInfo!.generationRetries, 'the mismatched attach forced exactly one retry').toBe(1);
    // Every pointer reads back the right bytes through the correctly-attached
    // reader.
    expect(reader.size).toBe(50);
    for (let i = 0; i < 50; i++) expect(reader.get(`k${i}`)).toBe(`v${i}`);
    await reader.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing (disk mode): a failing ValueReader open() closes the partially attached reader (no fd leak)', async () => {
  const dir = await tmpDir();
  try {
    // Seed with a snapshot on disk so the attach opens (and would leak) the
    // snapshot fd before the WAL open throws.
    const writer = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    for (let i = 0; i < 50; i++) await writer.set(`k${i}`, `v${i}`);
    await writer.compact();
    await writer.close();

    // The throw fires when the ValueReader opens db.wal to attach (the second
    // openSync on the WAL path: the first was recovery's scan) — after the
    // snapshot fd is already open. The reader is never published, so only the
    // callback itself can close it.
    const walPath = path.join(dir, 'db.wal');
    mockFsSyncForWal(walPath, {
      onOpenSync: (call) => {
        if (call === 2)
          throw Object.assign(new Error('injected wal open failure'), { code: 'EMFILE' });
      },
    });
    let closes = 0;
    const origClose = ValueReader.prototype.close;
    ValueReader.prototype.close = function (this: InstanceType<typeof ValueReader>): void {
      closes++;
      origClose.call(this);
    };
    try {
      const emfile = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        valueMode: 'disk',
        readOnly: true,
        indexGenerations: false,
      }).then(
        () => undefined,
        (error: unknown) => error as { code?: string },
      );
      expect(emfile?.code).toBe('EMFILE');
    } finally {
      ValueReader.prototype.close = origClose;
    }
    expect(closes, 'the partially attached ValueReader was closed instead of leaking its snapshot fd').toBe(1);

    // The injected failure was transient: a clean open recovers everything
    // (with the real node:fs restored, so no further openSync throws).
    restorePatches();
    const db = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      readOnly: true,
    });
    expect(db.size).toBe(50);
    expect(db.get('k49')).toBe('v49');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generation pairing: a stable writer costs a read-only open zero retries', async () => {
  const dir = await tmpDir();
  try {
    const writer = await MiniDb.open<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      autoCompact: false,
      indexGenerations: false,
    });
    for (let i = 0; i < 20; i++) await writer.set(`k${i}`, `v${i}`);

    const reader = await MiniDb.open<string>({ dir, valueCodec: 'string', readOnly: true });
    expect(reader.recoveryInfo!.generationRetries).toBe(0);
    expect(reader.size).toBe(20);
    await reader.close();
    await writer.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  'a read-only open racing a compaction rotation always recovers one complete generation',
  { timeout: 30_000 },
  async () => {
    // Deterministic interleave, no sleeps: the writer's rotation is parked
    // BETWEEN its two renames (the new snapshot is already in place, the old
    // full WAL is still at db.wal) while the read-only open runs its whole
    // recovery inside that window. The only consistent outcomes are one
    // complete generation or the other — never a mix.
    let armed = true;
    let parked!: () => void;
    let release!: () => void;
    const parkedPromise = new Promise<void>((r) => (parked = r));
    const gate = new Promise<void>((r) => (release = r));
    const realRename = fs.rename;
    const rename = async (src: PathLike, dst: PathLike): Promise<void> => {
      if (armed && String(src).endsWith('db.wal.tmp') && String(dst).endsWith('db.wal')) {
        armed = false;
        parked();
        await gate;
      }
      return realRename(src, dst);
    };
    patch(fs, 'rename', rename as typeof fs.rename);

    const dir = await tmpDir();
    try {
      const writer = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        fsyncPolicy: 'no',
        autoCompact: false,
        indexGenerations: false,
      });
      const N = 100;
      for (let i = 0; i < N; i++) await writer.set(`k${i}`, `v${i}`);

      const compactPromise = writer.compact();
      await parkedPromise; // the rotation is now parked between the two renames

      // The reader opens in the mid-rotation window: new snapshot + old full
      // WAL is a complete, consistent pairing (the replay is idempotent), and
      // the stable window costs no retry.
      const midReader = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        readOnly: true,
        indexGenerations: false,
      });
      expect(midReader.size).toBe(N);
      expect(midReader.get('k0')).toBe('v0');
      expect(midReader.get(`k${N - 1}`)).toBe(`v${N - 1}`);
      expect(midReader.recoveryInfo!.generationRetries).toBe(0);
      await midReader.close();

      release();
      await compactPromise;

      // After the rotation, a fresh open recovers the new generation, complete.
      const postReader = await MiniDb.open<string>({
        dir,
        valueCodec: 'string',
        readOnly: true,
        indexGenerations: false,
      });
      expect(postReader.size).toBe(N);
      expect(postReader.get('k0')).toBe('v0');
      expect(postReader.get(`k${N - 1}`)).toBe(`v${N - 1}`);
      expect(postReader.recoveryInfo!.generationRetries).toBe(0);
      await postReader.close();
      await writer.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

// ---- stage 6: async frame scanner -------------------------------------------

import fsSync from 'node:fs';

import {
  scanFrameRefsFd,
  scanFrameRefsFdAsync,
  MAGIC,
  DEFAULT_RESYNC_CANDIDATE_BUDGET,
} from '../src/codec.js';

test('async scanner: results match the sync scanner on clean and corrupt files', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    // Add corruption: damage k2's frame, then append two valid frames after it.
    const buf = await fs.readFile(walPath);
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff;
    const extra = Buffer.concat([
      encodeFrame({ type: TYPE_SET, key: Buffer.from('k5'), value: Buffer.from('v5') }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('k6'), value: Buffer.from('v6') }),
    ]);
    await fs.writeFile(walPath, Buffer.concat([buf, extra]));

    for (const mode of ['resync', 'strict'] as const) {
      const fd = fsSync.openSync(walPath, 'r');
      let syncRes;
      try {
        syncRes = scanFrameRefsFd(fd, { onCorrupt: mode });
      } finally {
        fsSync.closeSync(fd);
      }
      const fd2 = fsSync.openSync(walPath, 'r');
      let asyncRes;
      try {
        asyncRes = await scanFrameRefsFdAsync(fd2, { onCorrupt: mode });
      } finally {
        fsSync.closeSync(fd2);
      }
      expect(asyncRes.frames.map((f) => [
          f.type,
          f.frameOff,
          f.valueOff,
          f.valLen,
          f.frameLen,
          f.key.toString('binary'),
        ])).toStrictEqual(syncRes.frames.map((f) => [
          f.type,
          f.frameOff,
          f.valueOff,
          f.valLen,
          f.frameLen,
          f.key.toString('binary'),
        ]));
      expect(asyncRes.corruptRanges).toStrictEqual(syncRes.corruptRanges);
      expect(asyncRes.eofOffset).toBe(syncRes.eofOffset);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: frames larger than the read window scan identically (chunked fallback)', async () => {
  const dir = await tmpDir();
  try {
    // One 8 MiB value (exceeds the 4 MiB async window) between two small frames.
    const frames = Buffer.concat([
      encodeFrame({ type: TYPE_SET, key: Buffer.from('a'), value: Buffer.from('small-a') }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('big'), value: Buffer.alloc(8 << 20, 0x61) }),
      encodeFrame({ type: TYPE_SET, key: Buffer.from('z'), value: Buffer.from('small-z') }),
    ]);
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, frames);
    const fd = fsSync.openSync(walPath, 'r');
    let syncRes;
    try {
      syncRes = scanFrameRefsFd(fd, {});
    } finally {
      fsSync.closeSync(fd);
    }
    const fd2 = fsSync.openSync(walPath, 'r');
    let asyncRes;
    try {
      asyncRes = await scanFrameRefsFdAsync(fd2, {});
    } finally {
      fsSync.closeSync(fd2);
    }
    expect(asyncRes.frames.length).toBe(3);
    expect(asyncRes.frames.map((f) => [f.frameOff, f.valLen, f.frameLen])).toStrictEqual(syncRes.frames.map((f) => [f.frameOff, f.valLen, f.frameLen]));
    expect(asyncRes.eofOffset).toBe(syncRes.eofOffset);
    expect(asyncRes.corruptRanges).toStrictEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: cancellation aborts the scan with AbortError', async () => {
  const dir = await tmpDir();
  try {
    // A file large enough to span many yield points.
    const big = Buffer.concat(
      Array.from({ length: 200 }, (_, i) =>
        encodeFrame({
          type: TYPE_SET,
          key: Buffer.from(`k${i}`),
          value: Buffer.alloc(1 << 16, i & 0xff),
        }),
      ),
    );
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, big);
    const fd = fsSync.openSync(walPath, 'r');
    try {
      const controller = new AbortController();
      controller.abort(); // pre-aborted: the scan must not even start
      const aborted = await scanFrameRefsFdAsync(fd, { signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error as { name?: string },
      );
      expect(aborted?.name).toBe('AbortError');
    } finally {
      fsSync.closeSync(fd);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('async scanner: resync candidate budget bounds fake-magic storms', async () => {
  const dir = await tmpDir();
  try {
    // One valid frame, then a long storm of fake magic bytes (each looks like
    // a resync candidate but never validates), then a valid frame that must
    // be surrendered to the budget.
    const head = encodeFrame({ type: TYPE_SET, key: Buffer.from('head'), value: Buffer.from('v') });
    const storm = Buffer.alloc(DEFAULT_RESYNC_CANDIDATE_BUDGET * 2 + 64);
    for (let i = 0; i < storm.length; i += 2) MAGIC.copy(storm, i);
    const tail = encodeFrame({ type: TYPE_SET, key: Buffer.from('tail'), value: Buffer.from('v') });
    const walPath = path.join(dir, 'db.wal');
    await fs.writeFile(walPath, Buffer.concat([head, storm, tail]));

    const fd = fsSync.openSync(walPath, 'r');
    let res;
    try {
      const t0 = performance.now();
      res = await scanFrameRefsFdAsync(fd, { onCorrupt: 'resync', maxResyncCandidates: 128 });
      // The budget caps the work: 128 candidate validations, not 65k+.
      expect(performance.now() - t0 < 10_000, 'budget-bounded resync must be fast').toBeTruthy();
    } finally {
      fsSync.closeSync(fd);
    }
    // Only the head frame was recovered; the whole storm+tail is one corrupt
    // range (the strict outcome for the tail), and the scan stopped there.
    expect(res.frames.length).toBe(1);
    expect(res.frames[0]!.key.toString()).toBe('head');
    expect(res.corruptRanges.length).toBe(1);
    expect(res.corruptRanges[0]![0]).toBe(head.length);
    expect(res.eofOffset).toBe(head.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- phase 3: cooperative slicing of the recovered-op apply loops -----------

import { walApplySlicer, WAL_APPLY_OPS_PER_SLICE, WAL_APPLY_SLICE_MS } from '../src/recovery.js';

test('walApplySlicer trips on the op budget, then resets; the time budget trips independently', () => {
  const slice = walApplySlicer();
  for (let i = 1; i < WAL_APPLY_OPS_PER_SLICE; i++) expect(slice()).toBe(false);
  expect(slice()).toBe(true); // the op budget trips exactly at the cap
  expect(slice()).toBe(false); // counters reset for the next slice
  // The time budget trips below the op cap once the slice ran long enough.
  const timed = walApplySlicer();
  expect(timed()).toBe(false); // one op, well under the op cap
  const t0 = performance.now();
  while (performance.now() - t0 < WAL_APPLY_SLICE_MS + 5) {
    // busy-wait: keep this slice over its time budget with ops to spare
  }
  expect(timed()).toBe(true);
});

test('a generation WAL delta of large batch frames replays every op through the sliced apply loop', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    db.genBuildKickMinIntervalMs = Number.POSITIVE_INFINITY; // exactly one explicit generation
    for (let base = 0; base < 2000; base += 500) {
      await db.batch(
        Array.from({ length: 500 }, (_, i) => ({
          op: 'set' as const,
          key: `b${base + i}`,
          value: { n: base + i },
        })),
      );
    }
    await db.rebuildGeneration();
    await db.close();

    // A WAL delta of batch frames past the checkpoint: thousands of primitive
    // ops in a handful of frames — frame-granular yielding could never slice
    // this; the op/time budgets can. Small values keep the delta far below
    // the close-time republish threshold.
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    const gen = db.getIndexGeneration()?.id;
    for (let base = 0; base < 3000; base += 500) {
      await db.batch(
        Array.from({ length: 500 }, (_, i) => ({
          op: 'set' as const,
          key: `d${base + i}`,
          value: { n: base + i },
        })),
      );
    }
    await db.close();
    expect(db.getIndexGeneration()?.id).toBe(gen); // no close-time republish: the delta must be replayed

    db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    try {
      expect(db.recoveryInfo?.indexGeneration).toBeTruthy();
      expect(db.recoveryInfo?.walDeltaAppliedOps).toBe(3000);
      expect(db.size).toBe(5000);
      expect(db.get('d0')).toStrictEqual({ n: 0 });
      expect(db.get('d2999')).toStrictEqual({ n: 2999 });
      expect(db.get('b1999')).toStrictEqual({ n: 1999 });
      const status = db.lifecycleStatus();
      expect(status.state).toBe('ready');
      expect(status.path).toStrictEqual(['no-generation', 'generation-load', 'wal-catch-up', 'ready']);
      expect(status.phases.walApplyMs > 0).toBeTruthy();
    } finally {
      await db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
