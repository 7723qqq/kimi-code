// `v2-export` — copy the v2 home subdirs to a timestamped backup directory
// and write a manifest documenting the formats. Companion to `v2-detect`
// (M4 Q1): run after `v2-detect` reports orphaned subdirs, before
// upgrading past M5, to archive the data the Rust engine does not own.

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from './atomic-write.js';
import { detectV2Data, formatReport, type V2DetectReport } from './v2-detect.js';
import { TOP_LEVEL_CONFIG_FILES, V2_HOME_SUBDIRS } from './v2-home.js';

export interface V2ExportOptions {
  /** Override the timestamp used in the destination directory name. */
  readonly timestamp?: string;
}

export interface V2ExportResult {
  readonly report: V2DetectReport;
  /** Absolute path of the backup directory created. */
  readonly dest: string;
  /** Subdirs that were present and copied. */
  readonly copied: readonly string[];
}

function defaultTimestamp(now: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

export async function exportV2Data(
  home: string,
  destRoot: string,
  options: V2ExportOptions = {},
  now: Date = new Date(),
): Promise<V2ExportResult> {
  const report = await detectV2Data(home);
  const stamp = options.timestamp ?? defaultTimestamp(now);
  const dest = join(destRoot, `v2-home-${stamp}`);
  await mkdir(dest, { recursive: true, mode: 0o700 });

  const copied: string[] = [];
  for (const e of report.entries) {
    if (!e.present) continue;
    if (e.subdir.rel === '.') {
      // Top-level config: copy each whitelisted file individually so the
      // backup directory only contains the files the Rust engine needs to
      // re-read (or the user needs to archive), not every file under home.
      const destRoot = join(dest, 'config');
      await mkdir(destRoot, { recursive: true, mode: 0o700 });
      for (const name of TOP_LEVEL_CONFIG_FILES) {
        const src = join(home, name);
        const destFile = join(destRoot, name);
        try {
          await cp(src, destFile, { preserveTimestamps: true });
          copied.push(`config/${name}`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
      }
      continue;
    }
    const src = e.path;
    const destSub = join(dest, e.subdir.rel);
    await mkdir(destSub, { recursive: true, mode: 0o700 });
    // `recursive: true` copies the directory tree; preserve timestamps so
    // users can sort backups by mtime without re-running v2-detect.
    await cp(src, destSub, { recursive: true, preserveTimestamps: true });
    copied.push(e.subdir.rel);
  }

  const manifest = {
    home,
    dest,
    timestamp: stamp,
    formats: V2_HOME_SUBDIRS.map((s) => ({
      rel: s.rel,
      label: s.label,
      owner: s.owner,
      format: s.format,
    })),
    copied,
    detectReport: formatReport(report),
  };
  await atomicWrite(join(dest, 'v2-export-manifest.json'), JSON.stringify(manifest, null, 2));
  // Best-effort human summary too, in case JSON tooling isn't available.
  await writeFile(
    join(dest, 'v2-export-summary.txt'),
    [
      `v2-export: ${home} -> ${dest}`,
      `Copied ${copied.length} subdirs: ${copied.join(', ') || '(none)'}`,
      '',
      formatReport(report),
    ].join('\n'),
    'utf-8',
  );
  return { report, dest, copied };
}
