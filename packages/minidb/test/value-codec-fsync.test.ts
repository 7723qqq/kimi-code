// test/value-codec-fsync.test.ts
//
// Crash-durability ORDERING of writeFileAtomic — the sidecar writer behind
// db.indexes.json / db.compound-indexes.json / db.textindexes.json.
//
// The defect this pins: the tmp file's CONTENT was never fsync'd before the
// rename, so the rename's durability only covered the directory entry. A power
// loss right after a successful createIndex/createTextIndex could leave an
// empty or torn definition file; the next open then throws a SyntaxError and
// classifyStorageError maps that to the destructive 'rebuild' path (the
// review-round7 companion test locks that consumer-side consequence in).
//
// The two tests below record the syscall sequence from two angles:
//   1. a pure in-memory `node:fs/promises` fake (the compaction-fault.test.ts
//      technique) — no disk involved, the ordering is the whole assertion;
//   2. the real filesystem with wrapped handles, driven by the real callers
//      (createIndex / createCompoundIndex / createTextIndex on a MiniDb).
// Both require: open(tmp) -> writeFile -> sync -> close -> rename(tmp, file)
// -> rm(tmp) -> openDir -> syncDir. In particular sync() precedes the rename
// and the strict directory fsync is last.

import assert from 'node:assert/strict';
import { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
const realFs: typeof fs = { ...fs };
import path from 'node:path';

import { afterEach, test } from 'bun:test';

import { rmrf, tmpDir } from './helpers.js';

const SIDECARS = ['db.indexes.json', 'db.compound-indexes.json', 'db.textindexes.json'];

const seq: string[] = [];
const writes: { file: string; data: string }[] = [];
let tmpEncodings: string[] = [];

function reset(): void {
  seq.length = 0;
  writes.length = 0;
  tmpEncodings = [];
}

// The tracing layers below swap individual functions on the real
// node:fs/promises exports object (every minidb module default-imports that one
// object), because a builtin replaced with mock.module cannot be undone:
// mock.restore() leaves the replacement in place, so the next test would
// inherit a module with no mkdtemp at all. Patching is reversible — this
// afterEach restores every swapped function.
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
  reset();
});

function isSidecarPath(p: string): boolean {
  return SIDECARS.some((f) => p === f || p.includes(`${f}.tmp-`));
}

/** Replace node:fs/promises with an in-memory recorder: every call is answered
 *  from the recorded event list alone, no filesystem access at all. */
function mockRecordingFs(): void {
  const exports = {
    open: async (p: PathLike, flags?: string | number) => {
      const s = String(p);
      if (flags === 'r') {
        seq.push(`dopen:${s}`);
        return {
          sync: async () => seq.push(`dsync:${s}`),
          close: async () => seq.push(`dclose:${s}`),
        };
      }
      seq.push(`open:${s}`);
      return {
        writeFile: async (data: string, enc?: string) => {
          seq.push(`writeFile:${s}`);
          tmpEncodings.push(String(enc));
          writes.push({ file: s, data });
        },
        sync: async () => seq.push(`sync:${s}`),
        close: async () => seq.push(`close:${s}`),
      };
    },
    rename: async (src: PathLike, dst: PathLike) => {
      seq.push(`rename:${String(src)}->${String(dst)}`);
    },
    rm: async (p: PathLike) => {
      seq.push(`rm:${String(p)}`);
    },
    // Present so a regression back to fs.writeFile(tmp) fails on an explicit
    // message instead of "fs.writeFile is not a function".
    writeFile: async (p: PathLike) => {
      seq.push(`writeFile-unsynced:${String(p)}`);
      throw new Error(
        'writeFileAtomic: fs.writeFile(tmp) bypasses the content fsync (open+sync+rename required)',
      );
    },
  };
  // Swap the four functions writeFileAtomic can reach (plus the plain
  // fs.writeFile the old implementation used) with the recorder.
  patch(fs, 'open', exports.open);
  patch(fs, 'rename', exports.rename);
  patch(fs, 'rm', exports.rm);
  patch(fs, 'writeFile', exports.writeFile);
}

/** The exact discipline writeFileAtomic must follow for one sidecar: the tmp
 *  handle is opened, written, fsynced and closed, the rename publishes it, the
 *  finally removes the (already renamed) tmp, and the destination directory is
 *  fsynced strictly last. */
function assertAtomicOrder(file: string, dir: string): void {
  const openAt = seq.findIndex((e) => e.startsWith('open:') && e.includes(`${file}.tmp-`));
  assert.ok(openAt >= 0, `no tmp open was recorded for ${file}: ${seq.join(' | ')}`);
  const tmp = seq[openAt]!.slice('open:'.length);
  const dirSyncAt = seq.findIndex((e, i) => i > openAt && e === `dsync:${dir}`);
  assert.ok(dirSyncAt > openAt, `no directory fsync followed the ${file} rename: ${seq.join(' | ')}`);
  assert.deepEqual(
    seq.slice(openAt, dirSyncAt + 1),
    [
      `open:${tmp}`,
      `writeFile:${tmp}`,
      `sync:${tmp}`,
      `close:${tmp}`,
      `rename:${tmp}->${path.join(dir, file)}`,
      `rm:${tmp}`,
      `dopen:${dir}`,
      `dsync:${dir}`,
    ],
    `wrong syscall order for ${file}`,
  );
}

test('writeFileAtomic fsyncs the tmp content before renaming and fsyncs the dir last', async () => {
  mockRecordingFs();
  const { writeFileAtomic } = await import('../src/value-codec.js');
  const dir = path.join('/tmp', 'minidb-value-codec-fsync');
  const file = path.join(dir, 'db.indexes.json');
  const payload = JSON.stringify([{ name: 'byCity', field: 'city' }]);
  // The strict-fsyncDir option is still honored (an unsupported-directory-fsync
  // platform degrades through fsyncDir itself, not through the caller).
  const stats: { dirFsyncUnsupported?: boolean } = {};
  await writeFileAtomic(file, payload, { stats });

  assertAtomicOrder('db.indexes.json', dir);
  assert.equal(writes.length, 1);
  assert.ok(writes[0]!.file.startsWith(`${file}.tmp-`), `unexpected tmp name ${writes[0]!.file}`);
  assert.equal(writes[0]!.data, payload, 'the payload reaches the tmp file byte-for-byte');
  assert.equal(tmpEncodings[0], 'utf8', 'the tmp content is written as explicit utf8');
  assert.equal(
    seq.some((e) => e.startsWith('writeFile-unsynced:')),
    false,
    'fs.writeFile(tmp) would bypass the content fsync',
  );
});

test('every definition sidecar write is fsynced before its rename (real filesystem)', async () => {
  const dir = await tmpDir('minidb-value-codec-fsync-');
  const mocked = {
    ...realFs,
    open: (async (p: PathLike, flags?: string | number, mode?: string | number) => {
      const s = String(p);
      if (s === dir && flags === 'r') {
        const h = await realFs.open(s, flags, mode as never);
        seq.push(`dopen:${s}`);
        return {
          sync: async () => {
            seq.push(`dsync:${s}`);
            await h.sync();
          },
          close: async () => h.close(),
        };
      }
      const h = await realFs.open(p, flags as string, mode as never);
      if (!isSidecarPath(s)) return h;
      seq.push(`open:${s}`);
      return {
        writeFile: async (data: string, enc: string) => {
          seq.push(`writeFile:${s}`);
          writes.push({ file: s, data });
          await h.writeFile(data, enc);
        },
        sync: async () => {
          seq.push(`sync:${s}`);
          await h.sync();
        },
        close: async () => {
          seq.push(`close:${s}`);
          await h.close();
        },
      };
    }) as typeof fs.open,
    rename: (async (src: PathLike, dst: PathLike) => {
      const s = String(src);
      const d = String(dst);
      if (SIDECARS.includes(path.basename(d))) seq.push(`rename:${s}->${d}`);
      await realFs.rename(src, dst);
    }) as typeof fs.rename,
    rm: (async (p: PathLike, opts?: { force?: boolean }) => {
      const s = String(p);
      if (isSidecarPath(s)) seq.push(`rm:${s}`);
      await realFs.rm(p, opts);
    }) as typeof fs.rm,
  };
  patch(fs, 'open', mocked.open);
  patch(fs, 'rename', mocked.rename);
  patch(fs, 'rm', mocked.rm);

  const { MiniDb } = await import('../src/index.js');
  try {
    const db = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
      indexGenerations: false,
    });
    // One write per sidecar family: secondary, compound, then text.
    await db.createIndex('byCity', { field: 'city' });
    await db.createCompoundIndex('byGroup', { groupBy: 'g', orderBy: 'u' });
    await db.createTextIndex('body', { fields: ['body'] });
    await db.close();

    for (const file of SIDECARS) {
      const openAt = seq.findIndex((e) => e.startsWith('open:') && e.includes(`${file}.tmp-`));
      assert.ok(openAt >= 0, `no tmp write was recorded for ${file}: ${seq.join(' | ')}`);
      const tmp = seq[openAt]!.slice('open:'.length);
      assertAtomicOrder(file, dir);
      const last = writes.findLast((w) => w.file === tmp)!;
      const onDisk = await realFs.readFile(path.join(dir, file), 'utf8');
      assert.equal(onDisk, last.data, `${file} on disk must be exactly the fsynced payload`);
      assert.deepEqual(JSON.parse(onDisk), JSON.parse(last.data));
    }
  } finally {
    await rmrf(dir);
  }
});
