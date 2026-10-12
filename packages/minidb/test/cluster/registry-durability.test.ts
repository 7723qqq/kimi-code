// test/cluster/registry-durability.test.ts
//
// Crash-durability of the cluster index registry (cluster.indexes.json) — the
// file that records which index definitions every shard applies on open.
//
// The defects this pins:
//   1. saveRegistry wrote `fs.writeFile(tmp)` + rename with NO content fsync
//      and NO directory fsync, so a crash mid-create/drop could publish a
//      zero-length or torn registry. The next open then throws a SyntaxError,
//      which consumers classify as a destructive 'rebuild'.
//   2. the tmp name was the fixed `${file}.tmp-${process.pid}` and was never
//      removed on success or failure, so stranded temps accumulated.
//
// saveRegistry now goes through writeFileAtomic (unique tmp + content fsync +
// rename + strict directory fsync + tmp cleanup), and ClusterDb.open sweeps
// stranded temps whose owning pid is no longer alive.
//
// The sequence is recorded by wrapping the REAL node:fs/promises (the
// value-codec-fsync.test.ts technique, itself derived from
// compaction-fault.test.ts): the tmp handle must be opened, written, fsynced
// and closed, the rename must publish it, the finally removes the (already
// renamed) tmp, and the destination directory is fsynced strictly last.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, test, vi } from 'vitest';

import { rmrf, tmpDir } from '../e2e/helpers/tmp.js';

const REGISTRY = 'cluster.indexes.json';
const seq: string[] = [];

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  seq.length = 0;
});

/** Wrap node:fs/promises with the real implementation, recording only the
 *  syscalls that touch the cluster registry (its tmp siblings, its rename, and
 *  the strict directory fsync). Everything else delegates untouched, so this is
 *  a tracing layer, not a fake. */
function recordRealFs(clusterDir: string): void {
  const registryFile = path.join(clusterDir, REGISTRY);
  const tmpPrefix = `${registryFile}.tmp-`;
  const mocked = {
    ...fs,
    open: (async (p: string, flags?: string, mode?: number) => {
      const s = String(p);
      const real = await fs.open(p, flags as never, mode as never);
      if (s === clusterDir && flags === 'r') {
        return {
          sync: async () => {
            seq.push(`dsync:${s}`);
            await real.sync();
          },
          close: async () => real.close(),
        };
      }
      if (s.startsWith(tmpPrefix)) {
        seq.push(`open:${s}`);
        return {
          writeFile: async (data: string, enc?: string) => {
            seq.push(`writeFile:${s}`);
            await real.writeFile(data, enc as never);
          },
          sync: async () => {
            seq.push(`sync:${s}`);
            await real.sync();
          },
          close: async () => {
            seq.push(`close:${s}`);
            await real.close();
          },
        };
      }
      return real;
    }) as typeof fs.open,
    rename: (async (src: string, dst: string) => {
      if (String(dst) === registryFile) seq.push(`rename:${String(src)}->${String(dst)}`);
      await fs.rename(src, dst);
    }) as typeof fs.rename,
    rm: (async (p: string, opts?: { force?: boolean }) => {
      if (String(p).startsWith(tmpPrefix)) seq.push(`rm:${String(p)}`);
      await fs.rm(p, opts);
    }) as typeof fs.rm,
  };
  vi.doMock('node:fs/promises', () => ({ ...mocked, default: mocked }));
}

/** Record the same syscalls, but make the registry tmp's write FAIL after
 *  landing partial bytes — the crash-mid-write case that used to strand
 *  `${file}.tmp-${pid}` (fixed name, never deleted) forever. Both the
 *  handle-based path (the fix, via open+writeFile) and the plain
 *  fs.writeFile path (the old implementation) are hit by the same fault, so
 *  the tmp-cleanup assertion discriminates the two by itself. */
function recordRealFsWithFailingTmpWrite(clusterDir: string): void {
  const registryFile = path.join(clusterDir, REGISTRY);
  const tmpPrefix = `${registryFile}.tmp-`;
  const partial = JSON.stringify({ indexes: [{ name: 'byCity' }] }).slice(0, 12);
  const mocked = {
    ...fs,
    open: (async (p: string, flags?: string, mode?: number) => {
      const s = String(p);
      const real = await fs.open(p, flags as never, mode as never);
      if (s.startsWith(tmpPrefix)) {
        seq.push(`open:${s}`);
        return {
          writeFile: async () => {
            seq.push(`writeFile-throws:${s}`);
            await real.writeFile(partial, 'utf8');
            await real.close();
            throw new Error('simulated crash mid registry write');
          },
          sync: async () => {
            seq.push(`sync:${s}`);
            await real.sync();
          },
          close: async () => {
            seq.push(`close:${s}`);
            await real.close().catch(() => {});
          },
        };
      }
      return real;
    }) as typeof fs.open,
    writeFile: (async (p: string, data: unknown, enc?: unknown) => {
      if (String(p).startsWith(tmpPrefix)) {
        seq.push(`writeFile-unsynced-throws:${String(p)}`);
        await fs.writeFile(p, partial, enc as never);
        throw new Error('simulated crash mid registry write (unsynced tmp)');
      }
      await fs.writeFile(p, data as never, enc as never);
    }) as typeof fs.writeFile,
    rm: (async (p: string, opts?: { force?: boolean }) => {
      if (String(p).startsWith(tmpPrefix)) seq.push(`rm:${String(p)}`);
      await fs.rm(p, opts);
    }) as typeof fs.rm,
  };
  vi.doMock('node:fs/promises', () => ({ ...mocked, default: mocked }));
}

function registryTemps(entries: string[]): string[] {
  return entries.filter((entry) => entry.startsWith(`${REGISTRY}.tmp-`));
}

test('createIndex fsyncs the registry tmp before the rename and fsyncs the dir last', async () => {
  const dir = await tmpDir('minidb-cluster-registry-');
  recordRealFs(dir);
  try {
    const { ClusterDb } = await import('../../src/cluster/index.js');
    const db = await ClusterDb.open<{ city: string }>({
      dir,
      shardCount: 4,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    await db.createIndex('byCity', { field: 'city' });
    await db.close();

    const openAt = seq.findIndex((e) => e.startsWith('open:') && e.includes(`${REGISTRY}.tmp-`));
    assert.ok(openAt >= 0, `no registry tmp was written: ${seq.join(' | ')}`);
    const tmp = seq[openAt]!.slice('open:'.length);
    const dirSyncAt = seq.findIndex((e, i) => i > openAt && e === `dsync:${dir}`);
    assert.ok(
      dirSyncAt > openAt,
      `no directory fsync followed the registry rename: ${seq.join(' | ')}`,
    );
    assert.deepEqual(
      seq.slice(openAt, dirSyncAt + 1),
      [
        `open:${tmp}`,
        `writeFile:${tmp}`,
        `sync:${tmp}`,
        `close:${tmp}`,
        `rename:${tmp}->${path.join(dir, REGISTRY)}`,
        `rm:${tmp}`,
        `dsync:${dir}`,
      ],
      'wrong syscall order for the registry write',
    );

    // The published registry is complete and no tmp is left behind.
    const raw = JSON.parse(await fs.readFile(path.join(dir, REGISTRY), 'utf8')) as {
      indexes: { name: string }[];
    };
    assert.deepEqual(
      raw.indexes.map((i) => i.name),
      ['byCity'],
    );
    assert.deepEqual(registryTemps(await fs.readdir(dir)), [], 'no stranded registry tmp');
  } finally {
    await rmrf(dir);
  }
});

test('a registry write that fails mid-way leaves no tmp behind', async () => {
  const dir = await tmpDir('minidb-cluster-registry-');
  recordRealFsWithFailingTmpWrite(dir);
  try {
    const { ClusterDb } = await import('../../src/cluster/index.js');
    const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    await assert.rejects(
      () => db.createIndex('byCity', { field: 'city' }),
      /simulated crash mid registry write/,
    );
    const failedWrite = seq.find((e) => e.startsWith('writeFile-throws:'));
    assert.ok(
      failedWrite !== undefined,
      `the handle-based tmp write (the fixed path) was the one injected: ${seq.join(' | ')}`,
    );
    assert.deepEqual(
      registryTemps(await fs.readdir(dir)),
      [],
      'the failed write cleans up its own tmp',
    );
    // The registry itself was never published: the failed create left no
    // half-written definition file behind.
    assert.equal(
      await fs.stat(path.join(dir, REGISTRY)).then(
        () => true,
        () => false,
      ),
      false,
    );
    await db.close();
  } finally {
    await rmrf(dir);
  }
});

test('open sweeps a dead owner’s stranded registry tmp and leaves a live owner’s in flight tmp', async () => {
  const dir = await tmpDir('minidb-cluster-registry-');
  const reaped = spawnSync(process.execPath, ['-e', '']);
  assert.equal(reaped.status, 0);
  const deadPid = reaped.pid!;
  // A live peer whose tmp could still be renamed into place.
  const peer: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  try {
    const peerTmp = path.join(dir, `${REGISTRY}.tmp-${peer.pid}-1`);
    const deadTmp = path.join(dir, `${REGISTRY}.tmp-${deadPid}-1`);
    await fs.writeFile(peerTmp, '{"indexes":');
    await fs.writeFile(deadTmp, '{"indexes":');

    const { ClusterDb } = await import('../../src/cluster/index.js');
    const db = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    assert.deepEqual(
      registryTemps(await fs.readdir(dir)),
      [`${REGISTRY}.tmp-${peer.pid}-1`],
      'only the dead owner’s tmp is swept',
    );
    await db.close();

    // Once the peer is gone, its tmp is stranded too and the next open takes it.
    await new Promise<void>((resolve) => {
      peer.on('close', () => resolve());
      peer.kill('SIGKILL');
    });
    const db2 = await ClusterDb.open({ dir, shardCount: 4, valueCodec: 'json' });
    assert.deepEqual(registryTemps(await fs.readdir(dir)), [], 'the stranded tmp is gone');
    await db2.close();
  } finally {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL');
    await rmrf(dir);
  }
});
