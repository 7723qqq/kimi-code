import { describe, expect, it } from 'bun:test';

import type { WireRecord } from '#/wire/record';
import { activeChain, parseTree, type WireLine, type WireTree } from '#/wire/tree/tree';

function referenceActiveChain(entries: readonly WireLine[], tree: WireTree): WireLine[] {
  const segments = new Map(tree.segments.map((segment) => [segment.branch, segment]));
  const out: WireLine[] = [];
  const visited = new Set<string>();
  const walk = (branch: string, upto: number | undefined): void => {
    if (visited.has(branch)) {
      throw new Error(`agent.switched base chain cycles at branch '${branch}'`);
    }
    visited.add(branch);
    const segment = segments.get(branch);
    if (segment === undefined) {
      throw new Error(`agent.switched base chain references unknown branch '${branch}'`);
    }
    if (segment.edge !== undefined) walk(segment.edge.base.branch, segment.edge.base.line);
    const floor = segment.edge === undefined ? 1 : segment.edge.line + 1;
    const ceil = upto ?? segment.toLine;
    for (const entry of entries) {
      if (entry.record.type === 'agent.switched') continue;
      if (entry.line < floor || entry.line > ceil) continue;
      out.push(entry);
    }
  };
  walk(tree.activeBranch, undefined);
  return out;
}

function switched(branch: string, baseBranch: string, baseLine: number): WireRecord {
  return { type: 'agent.switched', branch, base: { branch: baseBranch, line: baseLine } };
}

function toEntries(records: readonly WireRecord[]): WireLine[] {
  return records.map((record, index) => ({ record, line: index + 1 }));
}

function lineNumbers(entries: readonly WireLine[]): number[] {
  return entries.map((entry) => entry.line);
}

function expectSameChain(entries: readonly WireLine[], tree: WireTree): WireLine[] {
  const actual = activeChain(entries, tree);
  const expected = referenceActiveChain(entries, tree);
  expect(lineNumbers(actual)).toEqual(lineNumbers(expected));
  expect(actual).toEqual(expected);
  for (const entry of actual) expect(entries).toContain(entry);
  return actual;
}

function createRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe('wire tree activeChain', () => {
  it('matches the previous recursive walk on a nested chain that skips each base segment hole', () => {
    const entries = toEntries([
      { type: 'metadata' },
      { type: 'wire.test.one' },
      { type: 'wire.test.two' },
      switched('b1', 'main', 2),
      { type: 'context.undo' },
      { type: 'context.undone' },
      { type: 'wire.test.three' },
      switched('b2', 'b1', 7),
      { type: 'context.undo' },
      { type: 'context.undone' },
      { type: 'wire.test.four' },
    ]);
    const tree = parseTree(entries, entries.length);

    expect(lineNumbers(expectSameChain(entries, tree))).toEqual([1, 2, 5, 6, 7, 9, 10, 11]);
  });

  it('matches the recursive walk when a later switch edge re-declares an existing branch', () => {
    const entries = toEntries([
      { type: 'metadata' },
      { type: 'wire.test.a' },
      { type: 'wire.test.b' },
      switched('b1', 'main', 1),
      switched('b1', 'main', 3),
      { type: 'context.undo' },
      { type: 'context.undone' },
      { type: 'wire.test.c' },
      { type: 'wire.test.d' },
    ]);
    const tree = parseTree(entries, entries.length);

    expect(tree.diagnostics.duplicateBranches).toEqual(['b1']);
    expect(lineNumbers(expectSameChain(entries, tree))).toEqual([1, 2, 3, 6, 7, 8, 9]);
  });

  it('matches the recursive walk on generated journals, including unknown base branches', () => {
    const random = createRandom(20240617);
    const branches = ['main', 'b1', 'b2', 'b3', 'missing'];
    const types = ['wire.test.a', 'wire.test.b', 'context.undo', 'context.undone'];
    for (let round = 0; round < 200; round += 1) {
      const total = 1 + Math.floor(random() * 40);
      const records: WireRecord[] = [{ type: 'metadata' }];
      for (let line = 2; line <= total; line += 1) {
        if (random() < 0.35) {
          const baseBranch = branches[Math.floor(random() * branches.length)]!;
          const baseLine = 1 + Math.floor(random() * (line - 1));
          records.push(
            switched(branches[Math.floor(random() * branches.length)]!, baseBranch, baseLine),
          );
          continue;
        }
        records.push({ type: types[Math.floor(random() * types.length)]! });
      }
      const entries = toEntries(records);
      const tree = parseTree(entries, entries.length);
      const expectedError = (() => {
        try {
          referenceActiveChain(entries, tree);
          return undefined;
        } catch (error) {
          return (error as Error).message;
        }
      })();
      if (expectedError === undefined) {
        expectSameChain(entries, tree);
        continue;
      }
      expect(() => activeChain(entries, tree)).toThrow(expectedError);
    }
  });

  it('scans entries once instead of once per chain segment', () => {
    const depth = 60;
    const fillerPerLevel = 100;
    const records: WireRecord[] = [{ type: 'metadata' }];
    let baseBranch = 'main';
    for (let level = 1; level <= depth; level += 1) {
      for (let filler = 0; filler < fillerPerLevel; filler += 1)
        records.push({ type: 'wire.test' });
      const switchLine = records.length + 1;
      records.push(switched(`b${level}`, baseBranch, switchLine - 1));
      baseBranch = `b${level}`;
    }
    for (let filler = 0; filler < 20; filler += 1) records.push({ type: 'wire.test' });
    const entries = toEntries(records);
    const tree = parseTree(entries, entries.length);

    const counted = (run: (input: readonly WireLine[]) => void) => {
      let reads = 0;
      const proxy = new Proxy(entries, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      run(proxy);
      return reads;
    };

    const reads = counted((input) => void activeChain(input, tree));
    const referenceReads = counted((input) => void referenceActiveChain(input, tree));

    expect(lineNumbers(activeChain(entries, tree))).toEqual(
      lineNumbers(referenceActiveChain(entries, tree)),
    );
    expect(activeChain(entries, tree)).toHaveLength(entries.length - depth);
    expect(reads).toBeLessThanOrEqual(entries.length * 2);
    expect(referenceReads).toBeGreaterThan(reads * 10);
  });

  it('returns an empty chain for an empty entries list', () => {
    expect(activeChain([], parseTree([], 0))).toEqual([]);
  });
});
