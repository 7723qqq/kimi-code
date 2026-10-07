import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sourceUserHistoryDir, targetUserHistoryDir } from '../paths.js';
import type { SessionMigrationFailure } from '../types.js';

export interface UserHistoryStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface UserHistoryStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
  /** Per-entry copy errors that did not abort the overall step. */
  readonly failures: readonly SessionMigrationFailure[];
}

export async function migrateUserHistoryStep(
  input: UserHistoryStepInput,
): Promise<UserHistoryStepResult> {
  const srcDir = sourceUserHistoryDir(input.sourceHome);
  const tgtDir = targetUserHistoryDir(input.targetHome);

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
    // One unreadable entry must not abort the whole step — a single broken
    // history file would otherwise strand the entire migration on every
    // retry. Record it and keep going; only when EVERY entry fails is the
    // step itself considered failed.
    attempted++;
    try {
      // Create the target dir only once there is a file to put in it — touching
      // it earlier aborts the whole migration if the path is blocked.
      if (!targetDirReady) {
        await mkdir(tgtDir, { recursive: true, mode: 0o700 });
        targetDirReady = true;
      }
      // Copy atomically: a crash mid-copy leaves only the temp file, never a
      // truncated final file that the next run would skip as complete.
      const tmpPath = `${tgtPath}.${process.pid}.tmp`;
      await copyFile(srcPath, tmpPath);
      await rename(tmpPath, tgtPath);
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
