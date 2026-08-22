import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { migrateUserHistoryStep } from '../../src/steps/user-history.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'src-'));
  tgt = await mkdtemp(join(tmpdir(), 'tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('migrateUserHistoryStep', () => {
  it('copies each <md5>.jsonl to target', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    await writeFile(join(src, 'user-history', 'aaa.jsonl'), '{"content":"echo"}\n');
    await writeFile(join(src, 'user-history', 'bbb.jsonl'), '{"content":"ls"}\n');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(2);
    expect(await readFile(join(tgt, 'user-history', 'aaa.jsonl'), 'utf-8')).toContain('echo');
  });

  it('skips files that already exist in target', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    await mkdir(join(tgt, 'user-history'), { recursive: true });
    await writeFile(join(src, 'user-history', 'aaa.jsonl'), '{"content":"src"}\n');
    await writeFile(join(tgt, 'user-history', 'aaa.jsonl'), '{"content":"tgt"}\n');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(await readFile(join(tgt, 'user-history', 'aaa.jsonl'), 'utf-8')).toContain('tgt');
  });

  it('no source dir: zero counters', async () => {
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(0);
  });

  it('does not create the target dir when there is nothing to copy', async () => {
    // Source user-history/ exists but is empty.
    await mkdir(join(src, 'user-history'), { recursive: true });
    // A file blocks the target path — mkdir there would throw.
    await writeFile(join(tgt, 'user-history'), 'blocking file');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r).toEqual({ copied: 0, skippedExisting: 0, failures: [] });
  });

  it('records a per-entry failure instead of aborting when one file is unreadable', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    const brokenPath = join(src, 'user-history', 'broken.jsonl');
    await writeFile(brokenPath, '{"content":"x"}\n');
    await writeFile(join(src, 'user-history', 'good.jsonl'), '{"content":"good"}\n');
    // Non-root cannot open this file, so copyFile fails for this entry only.
    await chmod(brokenPath, 0o000);
    try {
      const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });

      expect(r.copied).toBe(1);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]?.sourcePath).toBe(brokenPath);
      expect(r.failures[0]?.reason.length).toBeGreaterThan(0);
      expect(await readFile(join(tgt, 'user-history', 'good.jsonl'), 'utf-8')).toContain('good');
    } finally {
      await chmod(brokenPath, 0o600);
    }
  });

  it('throws only when EVERY entry fails', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    const a = join(src, 'user-history', 'aaa.jsonl');
    const b = join(src, 'user-history', 'bbb.jsonl');
    await writeFile(a, '{"content":"a"}\n');
    await writeFile(b, '{"content":"b"}\n');
    await chmod(a, 0o000);
    await chmod(b, 0o000);
    try {
      await expect(migrateUserHistoryStep({ sourceHome: src, targetHome: tgt })).rejects.toThrow(
        /all 2 entries under .* failed to migrate/,
      );
    } finally {
      await chmod(a, 0o600);
      await chmod(b, 0o600);
    }
  });
});
