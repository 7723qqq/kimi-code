import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { migratePlansStep } from '../../src/steps/plans.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'plans-src-'));
  tgt = await mkdtemp(join(tmpdir(), 'plans-tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('migratePlansStep', () => {
  it('copies plan files and reports no failures', async () => {
    await writeFile(join(src, 'plan.md'), '# plan');
    await writeFile(join(src, 'other.txt'), 'text');

    const r = await migratePlansStep({ targetHome: tgt, plansSourceDir: src });

    expect(r.copied).toBe(2);
    expect(r.skippedExisting).toBe(0);
    expect(r.failures).toEqual([]);
    await expect(readFile(join(tgt, 'plans', 'plan.md'), 'utf-8')).resolves.toBe('# plan');
  });

  it('is a no-op when the source dir does not exist', async () => {
    const r = await migratePlansStep({
      targetHome: tgt,
      plansSourceDir: join(src, 'missing'),
    });
    expect(r).toEqual({ copied: 0, skippedExisting: 0, failures: [] });
  });

  it('records a per-entry failure instead of aborting when one entry cannot be read', async () => {
    await writeFile(join(src, 'good.md'), 'GOOD');
    const broken = join(src, 'broken.md');
    await writeFile(broken, 'SECRET');
    await chmod(broken, 0o000);
    try {
      const r = await migratePlansStep({ targetHome: tgt, plansSourceDir: src });

      expect(r.copied).toBe(1);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]?.sourcePath).toBe(broken);
      expect(r.failures[0]?.reason.length).toBeGreaterThan(0);
      await expect(readFile(join(tgt, 'plans', 'good.md'), 'utf-8')).resolves.toBe('GOOD');
      expect(existsSync(join(tgt, 'plans', 'broken.md'))).toBe(false);
      const leftovers = (await readdir(join(tgt, 'plans'))).filter((e) => e.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await chmod(broken, 0o600);
    }
  });

  it('throws only when EVERY entry fails', async () => {
    await writeFile(join(src, 'a.md'), 'A');
    await writeFile(join(src, 'b.md'), 'B');
    await writeFile(join(tgt, 'plans'), 'blocking file');

    await expect(migratePlansStep({ targetHome: tgt, plansSourceDir: src })).rejects.toThrow(
      /all 2 entries under .* failed to migrate/,
    );
  });
});
