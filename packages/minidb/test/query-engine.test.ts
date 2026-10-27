import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Drives the query engine through the real db.query() path to cover the
// operators and path handling that the higher-level tests do not exercise.
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-qe-'));
}

async function seed() {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('a', {
    name: 'Ann',
    age: 30,
    city: 'Paris',
    tags: ['x', 'y'],
    score: 9.5,
    active: true,
  });
  await db.set('b', {
    name: 'Bob',
    age: 17,
    city: 'London',
    tags: ['y'],
    score: 4.2,
    active: false,
  });
  await db.set('c', { name: 'Eve', age: 25, city: 'Paris', tags: ['z'], score: 7.0 });
  await db.set('d', { name: 'Max', age: 40, city: 'Berlin', tags: [], score: 8.1, active: true });
  return { dir, db };
}

test('comparison operators $eq $ne $gt $gte $lt $lte', async () => {
  const { dir, db } = await seed();
  try {
    expect(db.query({ filter: { age: { $eq: 25 } } }).map((r) => r.key)).toStrictEqual(['c']);
    expect(db
        .query({ filter: { age: { $ne: 25 } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b', 'd']);
    expect(db
        .query({ filter: { age: { $gte: 30 } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'd']);
    expect(db
        .query({ filter: { age: { $lte: 25 } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['b', 'c']);
    // Combine two operators in one cond object (both must hold).
    expect(db.query({ filter: { age: { $gt: 17, $lt: 30 } } }).map((r) => r.key)).toStrictEqual(['c']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$in / $nin membership', async () => {
  const { dir, db } = await seed();
  try {
    expect(db
        .query({ filter: { city: { $in: ['Paris', 'Berlin'] } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'c', 'd']);
    expect(db
        .query({ filter: { city: { $nin: ['Paris'] } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['b', 'd']);
    // Non-array argument never matches.
    expect(db.query({ filter: { city: { $in: 'Paris' as unknown as string[] } } }).map((r) => r.key)).toStrictEqual([]);
    expect(db.query({ filter: { city: { $nin: 'Paris' as unknown as string[] } } }).map((r) => r.key)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$exists and $type', async () => {
  const { dir, db } = await seed();
  try {
    // 'active' is set on a, b, d but not c.
    expect(db
        .query({ filter: { active: { $exists: true } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b', 'd']);
    expect(db.query({ filter: { active: { $exists: false } } }).map((r) => r.key)).toStrictEqual(['c']);
    expect(db
        .query({ filter: { name: { $type: 'string' } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b', 'c', 'd']);
    expect(db.query({ filter: { age: { $type: 'string' } } }).map((r) => r.key)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$regex with string, [pattern, flags], RegExp and stateful global RegExp', async () => {
  const { dir, db } = await seed();
  try {
    expect(db.query({ filter: { name: { $regex: '^A' } } }).map((r) => r.key)).toStrictEqual(['a']);
    // Tuple form supplies flags.
    expect(db
        .query({ filter: { name: { $regex: ['^a', 'i'] as unknown as string } } })
        .map((r) => r.key)).toStrictEqual(['a']);
    // RegExp instance form.
    expect(db.query({ filter: { name: { $regex: /^B/ } } }).map((r) => r.key)).toStrictEqual(['b']);
    // A global RegExp is stateful; the engine must reset lastIndex so every
    // document is tested from the start.
    const g = /^E/g;
    expect(db.query({ filter: { name: { $regex: g } } }).map((r) => r.key)).toStrictEqual(['c']);
    // Non-string field never matches a regex.
    expect(db.query({ filter: { age: { $regex: '3' } } }).map((r) => r.key)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scalar RegExp value resets lastIndex between documents', async () => {
  const { dir, db } = await seed();
  try {
    const g = /^A/g;
    expect(db.query({ filter: { name: g } }).map((r) => r.key)).toStrictEqual(['a']);
    // Non-string value against a scalar RegExp never matches.
    expect(db.query({ filter: { age: /^3/ } }).map((r) => r.key)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('logical operators $and $or $nor $not', async () => {
  const { dir, db } = await seed();
  try {
    expect(db
        .query({ filter: { $and: [{ city: 'Paris' }, { age: { $gt: 20 } }] } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'c']);
    expect(db
        .query({ filter: { $or: [{ name: 'Ann' }, { name: 'Bob' }] } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b']);
    // $nor: matches documents that satisfy NONE of the branches.
    expect(db.query({ filter: { $nor: [{ city: 'Paris' }, { city: 'London' }] } }).map((r) => r.key)).toStrictEqual(['d']);
    expect(db
        .query({ filter: { $not: { city: 'Paris' } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['b', 'd']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown operator and non-array logical args never match', async () => {
  const { dir, db } = await seed();
  try {
    // Unknown operator falls through to the default case (no match).
    expect(db.query({ filter: { age: { $bogus: 1 } as never } }).map((r) => r.key)).toStrictEqual([]);
    // $and/$or/$nor with a non-array argument are treated as non-matching.
    expect(db.query({ filter: { $and: { city: 'Paris' } as never } }).map((r) => r.key)).toStrictEqual([]);
    expect(db.query({ filter: { $or: { city: 'Paris' } as never } }).map((r) => r.key)).toStrictEqual([]);
    expect(db.query({ filter: { $nor: { city: 'Paris' } as never } }).map((r) => r.key)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nested dot + bracket paths in filter and projection', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('p1', {
      user: { name: 'Ann', addr: { zip: '75001' } },
      items: [{ sku: 'A' }, { sku: 'B' }],
    });
    await db.set('p2', { user: { name: 'Bob', addr: { zip: '12345' } }, items: [{ sku: 'A' }] });
    await db.set('p3', { user: { name: 'Eve' }, items: [] });

    expect(db.query({ filter: { 'user.name': 'Bob' } }).map((r) => r.key)).toStrictEqual(['p2']);
    expect(db.query({ filter: { 'user.addr.zip': '75001' } }).map((r) => r.key)).toStrictEqual(['p1']);
    // Bracket index into an array element.
    expect(db.query({ filter: { 'items[1].sku': 'B' } }).map((r) => r.key)).toStrictEqual(['p1']);
    // Missing intermediate path does not match.
    expect(db.query({ filter: { 'user.addr.zip': 'x' } }).map((r) => r.key).length).toStrictEqual(0);

    // Nested projection rebuilds the nested shape in the output.
    const projected = db.query({
      filter: { 'user.name': 'Ann' },
      project: ['user.addr.zip', 'items[0].sku'],
    });
    expect(projected[0]!.value).toStrictEqual({
      user: { addr: { zip: '75001' } },
      items: [{ sku: 'A' }],
    });

    // Projecting a missing path drops it; empty project list returns the doc.
    expect(db.query({ project: [] })[0]!.value).toStrictEqual(await db.get('p1'));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sort ascending/descending, skip and limit', async () => {
  const { dir, db } = await seed();
  try {
    expect(db.query({ sort: { age: 1 } }).map((r) => r.key)).toStrictEqual(['b', 'c', 'a', 'd']);
    expect(db.query({ sort: { age: -1 } }).map((r) => r.key)).toStrictEqual(['d', 'a', 'c', 'b']);
    expect(db.query({ sort: { age: 1 }, skip: 1, limit: 2 }).map((r) => r.key)).toStrictEqual(['c', 'a']);
    // No filter / sort returns every document.
    expect(db.query().length).toBe(4);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bare RegExp filter is never answered from an equality index', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('a', { name: 'abigail' }, { dt: { seq: 1 } });
    await db.set('b', { name: 'abner' }, { dt: { seq: 2 } });
    await db.set('c', { name: 'zoe' }, { dt: { seq: 3 } });

    const before = db
      .query({ filter: { name: /^ab/ } })
      .map((r) => r.key)
      .toSorted();
    expect(before).toStrictEqual(['a', 'b']);
    expect(db.query({ dt: { seq: {} }, filter: { name: /^ab/ }, limit: 2 }).map((r) => r.key)).toStrictEqual(['a', 'b']);

    await db.createIndex('byName', { field: 'name' });

    const after = db
      .query({ filter: { name: /^ab/ } })
      .map((r) => r.key)
      .toSorted();
    expect(after).toStrictEqual(before);
    expect(after.length > 0).toBeTruthy();
    // The bare RegExp form and the explicit $regex form agree.
    expect(after).toStrictEqual(db
        .query({ filter: { name: { $regex: '^ab' } } })
        .map((r) => r.key)
        .toSorted());
    expect(await db
        .queryAsync({ filter: { name: /^ab/ } })
        .then((rs) => rs.map((r) => r.key).toSorted())).toStrictEqual(before);
    // dt fast path variant: every candidate would be rejected by hasEq.
    expect(db.query({ dt: { seq: {} }, filter: { name: /^ab/ }, limit: 2 }).map((r) => r.key)).toStrictEqual(['a', 'b']);
    expect((await db.queryAsync({ dt: { seq: {} }, filter: { name: /^ab/ }, limit: 2 })).map(
        (r) => r.key,
      )).toStrictEqual(['a', 'b']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dt sort orders identically with and without limit', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    // dt.seq and the value field seq point in opposite directions, so a plan
    // that sorted by the decoded value would visibly disagree.
    await db.set('a', { seq: 3 }, { dt: { seq: 1 } });
    await db.set('b', { seq: 2 }, { dt: { seq: 2 } });
    await db.set('c', { seq: 1 }, { dt: { seq: 3 } });

    for (const sortDir of [1, -1] as const) {
      const unbounded = db.query({ dt: { seq: {} }, sort: { seq: sortDir } }).map((r) => r.key);
      const bounded = db
        .query({ dt: { seq: {} }, sort: { seq: sortDir }, limit: 2 })
        .map((r) => r.key);
      expect(bounded).toStrictEqual(unbounded.slice(0, 2));
      const asyncUnbounded = (
        await db.queryAsync({ dt: { seq: {} }, sort: { seq: sortDir } })
      ).map((r) => r.key);
      const asyncBounded = (
        await db.queryAsync({ dt: { seq: {} }, sort: { seq: sortDir }, limit: 2 })
      ).map((r) => r.key);
      expect(asyncUnbounded).toStrictEqual(unbounded);
      expect(asyncBounded).toStrictEqual(bounded);
    }

    expect(db.query({ dt: { seq: {} }, sort: { seq: 1 } }).map((r) => r.key)).toStrictEqual(['a', 'b', 'c']);
    const desc = db.query({ dt: { seq: {} }, sort: { seq: -1 } }).map((r) => r.key);
    expect(desc).toStrictEqual(['c', 'b', 'a']);
    expect(desc[0]).toBe('c'); // dt largest first
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
