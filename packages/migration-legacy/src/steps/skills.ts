import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sourceSkillsDir, targetSkillsDir } from '../paths.js';
import type { SessionMigrationFailure } from '../types.js';

export interface SkillsStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface SkillsStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
  /** Per-entry copy errors that did not abort the overall step. */
  readonly failures: readonly SessionMigrationFailure[];
}

/**
 * Copy the user's legacy skills tree (~/.kimi/skills/) into kimi-code's
 * default user skills root (~/.kimi-code/skills/). Granularity is one
 * top-level entry per "skill unit" — that matches how the new scanner
 * treats a directory containing SKILL.md as a bundle and a flat .md as a
 * skill on its own. We do not filter non-skill entries; the new scanner
 * ignores anything it cannot parse, so passing it through preserves
 * arbitrary user assets without imposing a schema here.
 */
export async function migrateSkillsStep(input: SkillsStepInput): Promise<SkillsStepResult> {
  const srcDir = sourceSkillsDir(input.sourceHome);
  const tgtDir = targetSkillsDir(input.targetHome);

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

    try {
      await stat(srcPath);
    } catch {
      continue;
    }

    if (existsSync(tgtPath)) {
      skippedExisting++;
      continue;
    }

    // One unreadable/un-copyable entry must not abort the whole step — a
    // single broken skill would otherwise strand the entire migration on
    // every retry. Record it and keep going; only when EVERY entry fails is
    // the step itself considered failed.
    attempted++;
    try {
      // Defer creating the target root until we know there is something to put
      // in it — touching it earlier would fail when ~/.kimi-code/skills is
      // blocked by a file or has restrictive permissions, turning an empty
      // source into a hard error.
      if (!targetDirReady) {
        await mkdir(tgtDir, { recursive: true, mode: 0o700 });
        targetDirReady = true;
      }

      // Copy to a sibling temp path and rename into place so a crash mid-copy
      // never leaves a half-populated skill directory that the next idempotent
      // re-run would then `existsSync` and skip.
      const tmpPath = `${tgtPath}.${process.pid}.tmp`;
      try {
        await cp(srcPath, tmpPath, { recursive: true, errorOnExist: false, force: true });
        await rename(tmpPath, tgtPath);
      } catch (error) {
        await rm(tmpPath, { recursive: true, force: true }).catch(() => {});
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
