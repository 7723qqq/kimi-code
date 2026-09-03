// `v2-detect` — scan a v2 home directory and report which subdirs have
// data, with file counts and total bytes. Companion to the M4 Q1
// decision: run before upgrading past M5 to know what data would become
// orphaned when v2 is deleted.

import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { TOP_LEVEL_CONFIG_FILES, V2_HOME_SUBDIRS, type V2Subdir } from './v2-home.js';

export interface V2SubdirReport {
  /** Mirror of the V2Subdir definition. */
  readonly subdir: V2Subdir;
  /** Absolute path of the subdir (or home for the top-level config entry). */
  readonly path: string;
  /** True when the directory exists and has at least one file inside. */
  readonly present: boolean;
  /** Number of regular files (recursive, best-effort). */
  readonly fileCount: number;
  /** Total bytes across the same file set. */
  readonly totalBytes: number;
}

export interface V2DetectReport {
  readonly home: string;
  /** One entry per V2_HOME_SUBDIRS, in declaration order. */
  readonly entries: readonly V2SubdirReport[];
  /** Convenience: count of entries where `present === true`. */
  readonly presentCount: number;
}

async function walkFiles(root: string, acc: { count: number; bytes: number }): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, acc);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const s = await stat(full);
      acc.count += 1;
      acc.bytes += s.size;
    } catch {
      // unreadable file — skip, don't fail the whole report
    }
  }
}

/** Top-level config files (not a directory — only these files). */
const TOP_LEVEL_CONFIG_SET = new Set(TOP_LEVEL_CONFIG_FILES);

async function walkTopLevelFiles(
  root: string,
  acc: { count: number; bytes: number },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !TOP_LEVEL_CONFIG_SET.has(e.name)) continue;
    const full = join(root, e.name);
    try {
      const s = await stat(full);
      acc.count += 1;
      acc.bytes += s.size;
    } catch {
      // unreadable — skip
    }
  }
}

async function inspectSubdir(home: string, subdir: V2Subdir): Promise<V2SubdirReport> {
  // The `'.'` entry represents the top-level config files (config.toml /
  // local.toml / mcp.json) — only the files named in TOP_LEVEL_CONFIG_FILES,
  // never recurse into subdirs (those are reported under their own entry).
  if (subdir.rel === '.') {
    const acc = { count: 0, bytes: 0 };
    await walkTopLevelFiles(home, acc);
    return {
      subdir,
      path: home,
      present: acc.count > 0,
      fileCount: acc.count,
      totalBytes: acc.bytes,
    };
  }
  const path = join(home, subdir.rel);
  if (!existsSync(path)) {
    return { subdir, path, present: false, fileCount: 0, totalBytes: 0 };
  }
  const acc = { count: 0, bytes: 0 };
  await walkFiles(path, acc);
  return {
    subdir,
    path,
    present: acc.count > 0,
    fileCount: acc.count,
    totalBytes: acc.bytes,
  };
}

export async function detectV2Data(home: string): Promise<V2DetectReport> {
  const entries = await Promise.all(V2_HOME_SUBDIRS.map((s) => inspectSubdir(home, s)));
  return { home, entries, presentCount: entries.filter((e) => e.present).length };
}

/** Render a one-line summary for a single subdir. */
export function formatSubdirLine(e: V2SubdirReport): string {
  if (!e.present) return `${e.subdir.rel} — (empty)`;
  const kb = (e.totalBytes / 1024).toFixed(1);
  return `${e.subdir.rel} — ${e.fileCount} files, ${kb} KiB`;
}

/** Render a human-readable report (used by the CLI bin and tests). */
export function formatReport(report: V2DetectReport): string {
  const lines: string[] = [
    `v2-detect: ${report.home}`,
    `${report.presentCount}/${report.entries.length} v2 subdirs present.`,
  ];
  for (const e of report.entries) {
    lines.push(`  ${formatSubdirLine(e)} — ${e.subdir.label}`);
  }
  const orphaned = report.entries
    .filter((e) => e.present && !e.subdir.migrated)
    .map((e) => relative(report.home, e.path));
  if (orphaned.length > 0) {
    lines.push('');
    lines.push('Orphaned at M5 (v2 deletion; no Rust replacement):');
    for (const p of orphaned) lines.push(`  ${p}`);
    lines.push('Run `v2-export` before upgrading past M5 to archive them.');
  }
  return lines.join('\n');
}
