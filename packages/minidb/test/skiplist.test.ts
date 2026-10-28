
// test/skiplist.test.ts
import { expect, test } from 'bun:test';

import { SkipList, cmpString } from '../src/skiplist.js';

test('numeric: insert keeps order by (key, val)', () => {
  const sl = new SkipList(); // numeric key, string val tie-break
  sl.insert(3, 'c');
  sl.insert(1, 'a');
  sl.insert(2, 'b');
  sl.insert(2, 'a');
  expect(sl.toArray().map((n) => `${n.key}:${n.val}`)).toStrictEqual(['1:a', '2:a', '2:b', '3:c']);
  expect(sl.length).toBe(4);
});

test('getRank is 0-based and correct', () => {
  const sl = new SkipList();
  ['a', 'b', 'c', 'd', 'e'].forEach((m, i) => sl.insert(i, m));
  expect(sl.getRank(0, 'a')).toBe(0);
  expect(sl.getRank(2, 'c')).toBe(2);
  expect(sl.getRank(4, 'e')).toBe(4);
  expect(sl.getRank(9, 'z')).toBe(null);
});

test('getByRank returns the node at rank', () => {
  const sl = new SkipList();
  for (let i = 0; i < 100; i++) sl.insert(i, `m${i}`);
  expect(sl.getByRank(0)).toStrictEqual({ key: 0, val: 'm0' });
  expect(sl.getByRank(50)).toStrictEqual({ key: 50, val: 'm50' });
  expect(sl.getByRank(99)).toStrictEqual({ key: 99, val: 'm99' });
  expect(sl.getByRank(100)).toBe(null);
});

test('range with gte/lte/gt/lt/offset/count', () => {
  const sl = new SkipList();
  for (let i = 1; i <= 10; i++) sl.insert(i, `v${i}`);
  expect(sl.range({ gte: 3, lte: 7 }).map((n) => n.key)).toStrictEqual([3, 4, 5, 6, 7]);
  expect(sl.range({ gt: 3, lt: 7 }).map((n) => n.key)).toStrictEqual([4, 5, 6]);
  expect(sl.range({ gte: 1, lte: 10, offset: 2, count: 3 }).map((n) => n.key)).toStrictEqual([3, 4, 5]);
});

test('reverse range', () => {
  const sl = new SkipList();
  for (let i = 1; i <= 10; i++) sl.insert(i, `v${i}`);
  expect(sl.range({ gte: 3, lte: 7, reverse: true }).map((n) => n.key)).toStrictEqual([7, 6, 5, 4, 3]);
});

test('delete removes and keeps ranks consistent', () => {
  const sl = new SkipList();
  for (let i = 0; i < 50; i++) sl.insert(i, `m${i}`);
  expect(sl.delete(25, 'm25')).toBeTruthy();
  expect(!sl.delete(25, 'm25')).toBeTruthy();
  expect(sl.length).toBe(49);
  expect(sl.getRank(26, 'm26')).toBe(25);
  expect(sl.getByRank(25)).toStrictEqual({ key: 26, val: 'm26' });
});

test('string comparator orders keys and supports prefix scans', () => {
  const sl = new SkipList({ compareKey: cmpString });
  ['user:3', 'user:1', 'user:2', 'order:1', 'user:10'].forEach((k) => sl.insert(k, k));
  expect(sl.toArray().map((n) => n.key)).toStrictEqual(['order:1', 'user:1', 'user:10', 'user:2', 'user:3']);
  // prefix scan via range [prefix, prefix+\uFFFF]
  const pref = 'user:';
  const res = sl.range({ gte: pref, lt: pref + '\uFFFF' }).map((n) => n.key);
  expect(res).toStrictEqual(['user:1', 'user:10', 'user:2', 'user:3']);
});

test('iterate() yields the same sequence as range()', () => {
  const sl = new SkipList();
  for (let i = 1; i <= 20; i++) sl.insert(i, `v${i}`);
  const cases = [
    {},
    { gte: 3, lte: 7 },
    { gt: 3, lt: 7 },
    { gte: 1, lte: 20, offset: 2, count: 5 },
    { gte: 5 },
    { lte: 5 },
    { gte: 3, lte: 7, reverse: true },
    { reverse: true, offset: 2, count: 4 },
    { gt: 3, lt: 7, reverse: true },
    { gte: 100 }, // empty
    { lte: 0 }, // empty
  ];
  for (const opts of cases) {
    expect([...sl.iterate(opts)], `opts=${JSON.stringify(opts)}`).toStrictEqual(sl.range(opts));
  }
});

test('iterate() stops early (lazy)', () => {
  const sl = new SkipList();
  for (let i = 1; i <= 1000; i++) sl.insert(i, `v${i}`);
  let seen = 0;
  for (const _ of sl.iterate({ gte: 1 })) {
    seen++;
    if (seen === 3) break;
  }
  expect(seen).toBe(3);
});

test('matches a sorted reference under random operations', () => {
  const sl = new SkipList();
  const ref = new Map(); // val -> key
  for (let i = 0; i < 2000; i++) {
    const val = `k${(Math.random() * 200) | 0}`;
    if (Math.random() < 0.7 || ref.size === 0) {
      const key = (Math.random() * 1000) | 0;
      const old = ref.get(val);
      if (old !== undefined) sl.delete(old, val);
      ref.set(val, key);
      sl.insert(key, val);
    } else {
      const key = ref.get(val);
      if (key !== undefined) {
        sl.delete(key, val);
        ref.delete(val);
      }
    }
  }
  const sorted = [...ref.entries()]
    .map(([val, key]) => ({ key, val }))
    .toSorted((a, b) => a.key - b.key || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  expect(sl.toArray()).toStrictEqual(sorted);
  expect(sl.length).toBe(sorted.length);
});
