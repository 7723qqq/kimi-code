import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionMigrationFailure } from '../types.js';

export interface PlansStepInput {
  readonly targetHome: string;
  /**
   * kimi-cli hardcodes plan files at `~/.kimi/plans` regardless of
   * KIMI_SHARE_DIR (`tools/plan/heroes.py`), so the source is resolved from the
   * user's home, never from the migration source home. Injectable for tests.
   */
  readonly plansSourceDir?: string;
}

export interface PlansStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
  /** Per-entry copy errors that did not abort the overall step. */
  readonly failures: readonly SessionMigrationFailure[];
}

export function defaultPlansSourceDir(): string {
  return join(homedir(), '.kimi', 'plans');
}

export async function migratePlansStep(input: PlansStepInput): Promise<PlansStepResult> {
  const srcDir = input.plansSourceDir ?? defaultPlansSourceDir();
  const tgtDir = join(input.targetHome, 'plans');

  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch {
    return { copied: 0, skippedExisting: 0, failures: [] };
  }

  let copied = 0;
  let skippedExisting = 0;
  let attempted = 0;
  const failures: SessionMigrationFailure[] = [];
  let targetDirReady = false;
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const tgtPath = join(tgtDir, name);
    let st: Stats;
    try {
      st = await stat(srcPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (existsSync(tgtPath)) {
      skippedExisting++;
      continue;
    }
    // One unreadable/un-copyable plan file must not abort the whole step — a
    // single broken file would otherwise strand the entire migration on every
    // retry, after the other steps already wrote their output. Record it and
    // keep going; only when EVERY entry fails is the step itself failed.
    attempted++;
    try {
      if (!targetDirReady) {
        await mkdir(tgtDir, { recursive: true, mode: 0o700 });
        targetDirReady = true;
      }
      // Copy atomically: a crash mid-copy leaves only the temp file, never a
      // truncated final file that the next run would skip as complete.
      const tmpPath = `${tgtPath}.${process.pid}.tmp`;
      try {
        await copyFile(srcPath, tmpPath);
        await rename(tmpPath, tgtPath);
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      failures.push({
        sourcePath: srcPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    copied++;
  }

  if (attempted > 0 && failures.length === attempted) {
    const first = failures[0];
    throw new Error(
      `all ${attempted} entries under ${srcDir} failed to migrate` +
        (first === undefined ? '' : `; first error: ${first.reason}`),
    );
  }

  return { copied, skippedExisting, failures };
}
