import { describe, expect, it } from 'bun:test';

import { computeInvariants, computePartners } from '#/features/gitMemory/gitFacts';
import {
  GIT_MEMORY_INVARIANT_LIMIT,
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
