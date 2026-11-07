import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildIndex,
  cachePath,
  legacyCachePath,
  readIndex,
  removeLegacyIndex,
  writeIndex,
} from '#/features/gitMemory/cache';
import type { CommitRecord } from '#/features/gitMemory/types';

function commit(sha: string, files: string[]): CommitRecord {
  return {
    sha,
    date: '2026-10-30',
    author: 'luozihao',
    subject: 'fix: something',
    body: '',
    files,
  };
}

const commits: CommitRecord[] = [
  commit('a'.repeat(40), ['x.ts', 'y.ts']),
  commit('b'.repeat(40), ['x.ts']),
  commit('c'.repeat(40), ['x.ts']),
  commit('d'.repeat(40), ['x.ts']),
];

const dirs = ['src', 'src/features'];

const index = buildIndex('/repo', 'abc', 1500, commits, '2026-10-31T00:00:00.000Z', dirs);

function cacheFile(dir: string): string {
  return cachePath(join(dir, 'store'), dir);
}

describe('git memory cache', () => {
  it('round-trips an index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cacheFile(dir);
    expect(await writeIndex(path, index)).toBe(true);
    const read = await readIndex(path, 'abc', 1500);
    expect(read.kind).toBe('hit');
    if (read.kind === 'hit') expect(read.index).toEqual(index);
  });

  it('points each path at every commit that touched it, newest first', () => {
    expect(index.byPath['x.ts']).toEqual([0, 1, 2, 3]);
    expect(index.byPath['y.ts']).toEqual([0]);
  });

  it('keeps the directory tree in the index', () => {
    expect(index.dirs).toEqual(['src', 'src/features']);
  });

  it('misses when the head or the window differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cacheFile(dir);
    await writeIndex(path, index);
    expect((await readIndex(path, 'other', 1500)).kind).toBe('miss');
    expect((await readIndex(path, 'abc', 500)).kind).toBe('miss');
  });

  it('misses when the cache file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    expect((await readIndex(cacheFile(dir), 'abc', 1500)).kind).toBe('miss');
  });

  it('reports a corrupted cache as corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cacheFile(dir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{not json');
    expect((await readIndex(path, 'abc', 1500)).kind).toBe('corrupt');
  });

  it('writes stable key order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cacheFile(dir);
    await writeIndex(path, index);
    const text = await readFile(path, 'utf8');
    expect(text.indexOf('"byPath"')).toBeLessThan(text.indexOf('"commits"'));
    expect(text.indexOf('"commits"')).toBeLessThan(text.indexOf('"computedAt"'));
    expect(text.indexOf('"computedAt"')).toBeLessThan(text.indexOf('"headSha"'));
  });

  it('produces the same bytes for the same index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cacheFile(dir);
    await writeIndex(path, index);
    const first = await readFile(path, 'utf8');
    await writeIndex(path, index);
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('removes a legacy in-repo index and leaves foreign files alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const legacy = legacyCachePath(dir);
    await writeIndex(legacy, index);
    expect(await removeLegacyIndex(dir)).toBe(true);
    expect(await readFile(legacy, 'utf8').catch(() => null)).toBeNull();

    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, '{"note":"not ours"}', 'utf8');
    expect(await removeLegacyIndex(dir)).toBe(false);
    expect(await readFile(legacy, 'utf8')).toContain('not ours');
  });

  it('reports a write failure without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    expect(await writeIndex(join(blocker, 'git-memory.json'), index)).toBe(false);
  });
});
