import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { GIT_MEMORY_FILE_COMMITS, GIT_MEMORY_INDEX_VERSION } from './types';
import type { CommitRecord, GitMemoryIndex } from './types';

export type IndexReadResult =
  | { readonly kind: 'hit'; readonly index: GitMemoryIndex }
  | { readonly kind: 'miss' }
  | { readonly kind: 'corrupt' };

export function cachePath(repoRoot: string): string {
  return join(repoRoot, '.kimi-code', 'git-memory.json');
}

export function buildIndex(
  repoRoot: string,
  headSha: string,
  window: number,
  commits: readonly CommitRecord[],
  computedAt: string,
): GitMemoryIndex {
  const byPath: Record<string, number[]> = {};
  commits.forEach((commit, index) => {
    for (const file of commit.files) {
      const list = byPath[file];
      if (list === undefined) {
        byPath[file] = [index];
        continue;
      }
      if (list.length >= GIT_MEMORY_FILE_COMMITS) continue;
      list.push(index);
    }
  });
  return {
    version: GIT_MEMORY_INDEX_VERSION,
    repoRoot,
    headSha,
    window,
    computedAt,
    commits,
    byPath,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export async function readIndex(
  path: string,
  headSha: string,
  window: number,
): Promise<IndexReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { kind: 'miss' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'corrupt' };
  const index = parsed as GitMemoryIndex;
  if (index.version !== GIT_MEMORY_INDEX_VERSION) return { kind: 'miss' };
  if (index.headSha !== headSha) return { kind: 'miss' };
  if (index.window !== window) return { kind: 'miss' };
  return { kind: 'hit', index };
}

export async function readAnyIndex(path: string): Promise<GitMemoryIndex | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as GitMemoryIndex;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (parsed.version !== GIT_MEMORY_INDEX_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeIndex(path: string, index: GitMemoryIndex): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${stableStringify(index)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
