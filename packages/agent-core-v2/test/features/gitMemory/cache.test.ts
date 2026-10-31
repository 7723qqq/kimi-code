import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndex, cachePath, readIndex, writeIndex } from '#/features/gitMemory/cache';
import type { GitFacts } from '#/features/gitMemory/types';

const facts: GitFacts = {
  conventions: [{ prefix: 'fix', count: 12 }],
  invariants: [{ a: 'x.ts', b: 'y.ts', count: 60 }],
  fileChanges: {},
  filePartners: {},
  strengths: { 'x.ts': 42 },
};

const index = buildIndex('/repo', 'abc', 1500, facts, '2026-01-01T00:00:00.000Z');

describe('git memory cache', () => {
  it('round-trips an index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cachePath(dir);
    expect(await writeIndex(path, index)).toBe(true);
    const read = await readIndex(path, 'abc', 1500);
    expect(read.kind).toBe('hit');
    if (read.kind === 'hit') expect(read.index).toEqual(index);
  });

  it('misses when the head or the window differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cachePath(dir);
    await writeIndex(path, index);
    expect((await readIndex(path, 'other', 1500)).kind).toBe('miss');
    expect((await readIndex(path, 'abc', 500)).kind).toBe('miss');
  });

  it('misses when the cache file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    expect((await readIndex(cachePath(dir), 'abc', 1500)).kind).toBe('miss');
  });

  it('reports a corrupted cache as corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cachePath(dir);
    await mkdir(join(dir, '.kimi-code'), { recursive: true });
    await writeFile(path, '{not json');
    expect((await readIndex(path, 'abc', 1500)).kind).toBe('corrupt');
  });

  it('writes stable key order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cachePath(dir);
    await writeIndex(path, index);
    const text = await readFile(path, 'utf8');
    expect(text.indexOf('"computedAt"')).toBeLessThan(text.indexOf('"facts"'));
    expect(text.indexOf('"facts"')).toBeLessThan(text.indexOf('"headSha"'));
    expect(text.indexOf('"headSha"')).toBeLessThan(text.indexOf('"repoRoot"'));
  });

  it('produces the same bytes for the same index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const path = cachePath(dir);
    await writeIndex(path, index);
    const first = await readFile(path, 'utf8');
    await writeIndex(path, index);
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('reports a write failure without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitmem-'));
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    expect(await writeIndex(join(blocker, 'git-memory.json'), index)).toBe(false);
  });
});
