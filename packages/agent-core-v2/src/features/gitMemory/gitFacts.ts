import {
  GIT_MEMORY_INVARIANT_LIMIT,
  GIT_MEMORY_INVARIANT_MIN_COUNT,
  GIT_MEMORY_INVARIANT_MIN_SCORE,
  GIT_MEMORY_MAX_FILES_PER_GROUP,
  GIT_MEMORY_PARTNER_MIN_COUNT,
  GIT_MEMORY_PARTNER_MIN_SCORE,
} from './types';
import type { CommitInput, Invariant, Partner } from './types';

interface CoChangePair {
  readonly a: string;
  readonly b: string;
  readonly count: number;
  readonly score: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function bulkFreeCommits(commits: readonly CommitInput[]): readonly CommitInput[] {
  return commits.filter(
    (commit) => new Set(commit.files).size <= GIT_MEMORY_MAX_FILES_PER_GROUP,
  );
}

function coChangePairs(commits: readonly CommitInput[]): CoChangePair[] {
  const fileCommits = new Map<string, Set<number>>();
  const pairCounts = new Map<string, number>();
  const kept = bulkFreeCommits(commits);
  for (let index = 0; index < kept.length; index++) {
    const files = [...new Set(kept[index]!.files)];
    for (const file of files) {
      let set = fileCommits.get(file);
      if (set === undefined) {
        set = new Set<number>();
        fileCommits.set(file, set);
      }
      set.add(index);
    }
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = pairKey(files[i]!, files[j]!);
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: CoChangePair[] = [];
  for (const [key, count] of pairCounts) {
    const [a, b] = key.split('\u0000');
    if (a === undefined || b === undefined) continue;
    const setA = fileCommits.get(a);
    const setB = fileCommits.get(b);
    if (setA === undefined || setB === undefined) continue;
    let shared = 0;
    for (const commit of setA) {
      if (setB.has(commit)) shared += 1;
    }
    pairs.push({ a, b, count, score: shared / Math.sqrt(setA.size * setB.size) });
  }
  return pairs;
}

export function computePartners(commits: readonly CommitInput[]): Record<string, Partner[]> {
  const byFile = new Map<string, Partner[]>();
  const add = (file: string, partner: Partner): void => {
    const list = byFile.get(file);
    if (list === undefined) {
      byFile.set(file, [partner]);
      return;
    }
    list.push(partner);
  };
  for (const pair of coChangePairs(commits)) {
    if (pair.count < GIT_MEMORY_PARTNER_MIN_COUNT) continue;
    if (pair.score < GIT_MEMORY_PARTNER_MIN_SCORE) continue;
    add(pair.a, { path: pair.b, count: pair.count, score: pair.score });
    add(pair.b, { path: pair.a, count: pair.count, score: pair.score });
  }
  const out: Record<string, Partner[]> = {};
  for (const [file, list] of byFile) {
    list.sort(
      (x, y) =>
        y.score - x.score || y.count - x.count || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
    );
    out[file] = list;
  }
  return out;
}

export function computeInvariants(commits: readonly CommitInput[]): Invariant[] {
  return coChangePairs(commits)
    .filter(
      (pair) =>
        pair.count >= GIT_MEMORY_INVARIANT_MIN_COUNT &&
        pair.score >= GIT_MEMORY_INVARIANT_MIN_SCORE,
    )
    .sort(
      (x, y) =>
        y.count - x.count ||
        (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0),
    )
    .slice(0, GIT_MEMORY_INVARIANT_LIMIT)
    .map((pair) => ({ a: pair.a, b: pair.b, count: pair.count }));
}
