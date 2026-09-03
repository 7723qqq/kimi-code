import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectV2Data,
  exportV2Data,
  formatReport,
  V2_HOME_SUBDIRS,
} from '../src/index.js';

let home: string;
let dest: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'v2-home-'));
  dest = await mkdtemp(join(tmpdir(), 'v2-dest-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

async function writeFileRecursive(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('v2-detect', () => {
  it('reports every subdir as absent on an empty home', async () => {
    const report = await detectV2Data(home);
    expect(report.home).toBe(home);
    expect(report.entries).toHaveLength(V2_HOME_SUBDIRS.length);
    expect(report.presentCount).toBe(0);
    for (const e of report.entries) {
      expect(e.present).toBe(false);
      expect(e.fileCount).toBe(0);
      expect(e.totalBytes).toBe(0);
    }
    expect(formatReport(report)).toContain('0/');
  });

  it('counts files and bytes for subdirs with data', async () => {
    await writeFileRecursive(join(home, 'sessions', 'a.jsonl'), '{"turn":1}\n');
    await writeFileRecursive(join(home, 'sessions', 'b.jsonl'), '{"turn":2}\n');
    await writeFileRecursive(join(home, 'store', 'log.wal'), 'x'.repeat(2048));
    await writeFileRecursive(join(home, 'mcp.json'), '{}');

    const report = await detectV2Data(home);
    expect(report.presentCount).toBe(3);
    const sessions = report.entries.find((e) => e.subdir.rel === 'sessions');
    expect(sessions?.present).toBe(true);
    expect(sessions?.fileCount).toBe(2);
    expect(sessions?.totalBytes).toBe('{"turn":1}\n{"turn":2}\n'.length);
    const store = report.entries.find((e) => e.subdir.rel === 'store');
    expect(store?.totalBytes).toBe(2048);
    const top = report.entries.find((e) => e.subdir.rel === '.');
    expect(top?.present).toBe(true);
    expect(top?.fileCount).toBe(1);
  });

  it('walks nested directories recursively', async () => {
    await writeFileRecursive(join(home, 'cache', 'a', 'b', 'c.txt'), 'deep');
    const report = await detectV2Data(home);
    const cache = report.entries.find((e) => e.subdir.rel === 'cache');
    expect(cache?.fileCount).toBe(1);
    expect(cache?.totalBytes).toBe(4);
  });
});

describe('v2-export', () => {
  it('copies only present subdirs and writes the manifest', async () => {
    await writeFileRecursive(join(home, 'sessions', 'x.jsonl'), 'session\n');
    await writeFileRecursive(join(home, 'store', 'a.wal'), 'x'.repeat(512));
    // credentials, blobs, logs, cache, mcp.json: empty or absent

    const fixed = new Date('2026-09-01T12:00:00Z');
    const result = await exportV2Data(home, dest, {}, fixed);
    expect(result.copied).toEqual(expect.arrayContaining(['sessions', 'store']));
    expect(result.dest).toMatch(/v2-home-20260901-120000Z$/);

    const manifest = JSON.parse(await readFile(join(result.dest, 'v2-export-manifest.json'), 'utf-8'));
    expect(manifest.home).toBe(home);
    expect(manifest.copied).toEqual(expect.arrayContaining(['sessions', 'store']));
    expect(manifest.formats).toHaveLength(V2_HOME_SUBDIRS.length);
    for (const f of manifest.formats) {
      expect(f).toHaveProperty('rel');
      expect(f).toHaveProperty('format');
    }

    const summary = await readFile(join(result.dest, 'v2-export-summary.txt'), 'utf-8');
    expect(summary).toContain('Copied 2 subdirs');
    expect(summary).toContain('store');
  });

  it('uses the override timestamp when provided', async () => {
    await writeFileRecursive(join(home, 'sessions', 'x.jsonl'), 'x');
    const result = await exportV2Data(home, dest, { timestamp: '2099-01-01-000000Z' });
    expect(result.dest).toMatch(/v2-home-2099-01-01-000000Z$/);
  });
});
