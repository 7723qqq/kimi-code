import { describe, expect, it } from 'bun:test';

import {
  computeConventions,
  computeFileChanges,
  computeInvariants,
  computePartners,
  computeStrengths,
} from '#/features/gitMemory/gitFacts';
import {
  GIT_MEMORY_CHANGE_GROUPS,
  GIT_MEMORY_INVARIANT_LIMIT,
  GIT_MEMORY_MAX_FILES_PER_GROUP,
  GIT_MEMORY_PARTNER_MIN_SCORE,
} from '#/features/gitMemory/types';
import type { CommitInput } from '#/features/gitMemory/types';

function commit(sha: string, files: string[]): CommitInput {
  return { sha, subject: 'x', date: '2026-01-01', files };
}

describe('co-change partners', () => {
  it('keeps a pair that always travels together even inside large commits', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const commits = Array.from({ length: 12 }, (_, i) => commit(`s${i}`, ten));
    const partners = computePartners(commits);
    expect((partners['f0.ts'] ?? []).map((p) => p.path)).toContain('f1.ts');
  });

  it('drops a one-off coincidence', () => {
    const commits = Array.from({ length: 12 }, (_, i) => commit(`s${i}`, ['a.ts', 'b.ts']));
    commits.push(commit('odd', ['a.ts', 'c.ts']));
    const partners = computePartners(commits);
    expect((partners['a.ts'] ?? []).map((p) => p.path)).toContain('b.ts');
    expect((partners['a.ts'] ?? []).map((p) => p.path)).not.toContain('c.ts');
  });

  it('ignores a bulk commit when deriving coupling', () => {
    const bulk = Array.from({ length: 40 }, (_, i) => `bulk${i}.ts`);
    const commits = [
      commit('bulk', bulk),
      ...Array.from({ length: 12 }, (_, i) => commit(`s${i}`, ['a.ts', 'b.ts'])),
    ];
    const partners = computePartners(commits);
    expect(partners['bulk0.ts'] ?? []).toHaveLength(0);
  });

  it('reports the co-occurrence count and the similarity score', () => {
    const commits = Array.from({ length: 12 }, (_, i) => commit(`s${i}`, ['a.ts', 'b.ts']));
    const partner = (computePartners(commits)['a.ts'] ?? [])[0];
    expect(partner?.count).toBe(12);
    expect(partner?.score).toBeGreaterThanOrEqual(GIT_MEMORY_PARTNER_MIN_SCORE);
  });
});

describe('invariants', () => {
  it('keeps a pair that always travels together', () => {
    const commits = Array.from({ length: 12 }, (_, i) => commit(`s${i}`, ['x.ts', 'y.ts']));
    const invariants = computeInvariants(commits);
    expect(invariants).toHaveLength(1);
    expect(invariants[0]?.a).toBe('x.ts');
    expect(invariants[0]?.b).toBe('y.ts');
    expect(invariants[0]?.count).toBe(12);
  });

  it('caps the list at the configured limit', () => {
    const commits: CommitInput[] = [];
    for (let i = 0; i < GIT_MEMORY_INVARIANT_LIMIT + 5; i++) {
      for (let j = 0; j < 5; j++) {
        commits.push(commit(`s${i}-${j}`, [`a${i}.ts`, `b${i}.ts`]));
      }
    }
    expect(computeInvariants(commits).length).toBe(GIT_MEMORY_INVARIANT_LIMIT);
  });

  it('drops a pair that only sometimes travels together', () => {
    const commits: CommitInput[] = [];
    for (let i = 0; i < 12; i++) commits.push(commit(`s${i}`, ['x.ts', 'y.ts']));
    for (let i = 0; i < 12; i++) commits.push(commit(`t${i}`, ['x.ts', 'z.ts']));
    const invariants = computeInvariants(commits);
    expect(invariants.map((i) => `${i.a}|${i.b}`)).not.toContain('x.ts|z.ts');
  });

  it('orders invariants by co-occurrence count', () => {
    const commits: CommitInput[] = [];
    for (let i = 0; i < 20; i++) commits.push(commit(`s${i}`, ['x.ts', 'y.ts']));
    for (let i = 0; i < 10; i++) commits.push(commit(`t${i}`, ['p.ts', 'q.ts']));
    const invariants = computeInvariants(commits);
    expect(invariants[0]?.a).toBe('x.ts');
    expect(invariants[0]?.count).toBe(20);
  });
});

describe('change groups', () => {
  it('keeps only the most recent groups per file, newest first', () => {
    const commits = ['2026-01-04', '2026-01-03', '2026-01-02', '2026-01-01'].map(
      (date, i) => ({
        sha: `s${i}`,
        subject: 'x',
        date,
        files: ['p.ts'],
      }),
    );
    const groups = computeFileChanges(commits)['p.ts'] ?? [];
    expect(groups).toHaveLength(GIT_MEMORY_CHANGE_GROUPS);
    expect(groups[0]?.date).toBe('2026-01-04');
    expect(groups[2]?.date).toBe('2026-01-02');
  });

  it('truncates a group touching more than the file limit', () => {
    const many = Array.from(
      { length: GIT_MEMORY_MAX_FILES_PER_GROUP + 5 },
      (_, i) => `f${i}.ts`,
    );
    const groups =
      computeFileChanges([
        { sha: 's', subject: 'x', date: '2026-01-01', files: many },
      ])['f0.ts'] ?? [];
    expect(groups[0]?.files).toHaveLength(GIT_MEMORY_MAX_FILES_PER_GROUP);
    expect(groups[0]?.truncated).toBe(true);
  });

  it('keeps every file of a normal group', () => {
    const groups =
      computeFileChanges([
        { sha: 's', subject: 'x', date: '2026-01-01', files: ['a.ts', 'b.ts'] },
      ])['a.ts'] ?? [];
    expect(groups[0]?.files).toHaveLength(2);
    expect(groups[0]?.truncated).toBe(false);
  });
});

describe('conventions', () => {
  it('counts commit prefixes in descending order', () => {
    const conventions = computeConventions([
      'fix(a): x',
      'fix(a): y',
      'feat(b): z',
      'docs: w',
    ]);
    expect(conventions[0]).toEqual({ prefix: 'fix(a)', count: 2 });
    expect(conventions.map((c) => c.prefix)).toContain('feat(b)');
    expect(conventions.map((c) => c.prefix)).toContain('docs');
  });

  it('buckets a subject without a prefix', () => {
    const conventions = computeConventions(['plain subject']);
    expect(conventions[0]).toEqual({ prefix: '(none)', count: 1 });
  });
});

describe('strengths', () => {
  it('ranks a frequently changed file above a rarely changed one', () => {
    const commits = [
      ...Array.from({ length: 9 }, (_, i) => ({
        sha: `s${i}`,
        subject: 'x',
        date: '2026-01-01',
        files: ['hot.ts'],
      })),
      { sha: 'cold', subject: 'x', date: '2026-01-01', files: ['cold.ts'] },
    ];
    const strengths = computeStrengths(commits);
    expect(strengths['hot.ts']).toBeGreaterThan(strengths['cold.ts'] ?? 0);
  });

  it('keeps strengths inside a 0..100 integer range', () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({
      sha: `s${i}`,
      subject: 'x',
      date: '2026-01-01',
      files: ['a.ts', 'b.ts'],
    }));
    const strengths = computeStrengths(commits);
    for (const value of Object.values(strengths)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
