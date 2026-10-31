import {
  GIT_MEMORY_CHANGE_GROUPS,
  GIT_MEMORY_INVARIANT_LIMIT,
  GIT_MEMORY_INVARIANT_MIN_COUNT,
  GIT_MEMORY_INVARIANT_MIN_SCORE,
  GIT_MEMORY_MAX_FILES_PER_GROUP,
  GIT_MEMORY_PARTNER_MIN_COUNT,
  GIT_MEMORY_PARTNER_MIN_SCORE,
} from './types';
import type {
  ChangeGroup,
  CommitInput,
  ConventionEntry,
  Invariant,
  Partner,
} from './types';

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

const CONVENTION_PREFIX = /^([a-z]+)(\([^)]*\))?:/;

function dirsOf(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    dirs.add(parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? file));
  }
  return [...dirs].sort();
}

export function computeFileChanges(commits: readonly CommitInput[]): Record<string, ChangeGroup[]> {
  const byFile = new Map<string, ChangeGroup[]>();
  for (const commit of commits) {
    const files = [...new Set(commit.files)];
    const truncated = files.length > GIT_MEMORY_MAX_FILES_PER_GROUP;
    const group: ChangeGroup = {
      sha: commit.sha,
      subject: commit.subject,
      date: commit.date,
      files: truncated ? files.slice(0, GIT_MEMORY_MAX_FILES_PER_GROUP) : files,
      fileCount: files.length,
      dirs: dirsOf(files),
      truncated,
    };
    for (const file of files) {
      const list = byFile.get(file);
      if (list === undefined) {
        byFile.set(file, [group]);
        continue;
      }
      if (list.length >= GIT_MEMORY_CHANGE_GROUPS) continue;
      if (list.some((existing) => existing.sha === group.sha)) continue;
      list.push(group);
    }
  }
  const out: Record<string, ChangeGroup[]> = {};
  for (const [file, list] of byFile) out[file] = list;
  return out;
}

export function computeConventions(subjects: readonly string[]): ConventionEntry[] {
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const match = CONVENTION_PREFIX.exec(subject);
    const prefix = match === null ? '(none)' : match[0].slice(0, -1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort(
      (x, y) =>
        y.count - x.count || (x.prefix < y.prefix ? -1 : x.prefix > y.prefix ? 1 : 0),
    )
    .slice(0, 8);
}

export function computeStrengths(commits: readonly CommitInput[]): Record<string, number> {
  const counts = new Map<string, number>();
  const latest = new Map<string, number>();
  commits.forEach((commit, index) => {
    for (const file of new Set(commit.files)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
      if (!latest.has(file)) latest.set(file, index);
    }
  });
  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }
  const span = Math.max(commits.length - 1, 1);
  const out: Record<string, number> = {};
  for (const [file, count] of counts) {
    const countNorm = maxCount === 0 ? 0 : count / maxCount;
    const recency = 1 - (latest.get(file) ?? 0) / span;
    const value = 70 * countNorm + 30 * recency;
    out[file] = Math.min(100, Math.max(0, Math.round(value)));
  }
  return out;
}
