import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// test/query.test.ts
import { expect, test } from 'bun:test';

import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-query-'));
}

test('key range + prefix scan', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    for (const k of ['user:3', 'user:1', 'user:2', 'order:1']) await db.set(k, k);
    expect(db.scan({ gte: 'user:', lte: 'user:~' }).map((r) => r.key)).toStrictEqual(['user:1', 'user:2', 'user:3']);
    expect(db.prefix('user:').map((r) => r.key)).toStrictEqual(['user:1', 'user:2', 'user:3']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dt columns: set, range query, persist across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    const jan = Date.parse('2024-01-01');
    const mar = Date.parse('2024-03-01');
    const jun = Date.parse('2024-06-01');
    await db.set('a', { n: 1 }, { dt: { created: jan } });
    await db.set('b', { n: 2 }, { dt: { created: mar } });
    await db.set('c', { n: 3 }, { dt: { created: jun } });

    expect(db.dtColumns().toSorted()).toStrictEqual(['created']);
    const rows = db.dtRange('created', { gte: jan, lte: mar });
    expect(rows.map((r) => r.key)).toStrictEqual(['a', 'b']);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    expect(db.dtRange('created', { gt: mar }).map((r) => r.key)).toStrictEqual(['c']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('value filter (Mongo-like) with operators', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('a', { name: 'Ann', age: 30, tags: ['x', 'y'] });
    await db.set('b', { name: 'Bob', age: 17, tags: ['y'] });
    await db.set('c', { name: 'Eve', age: 25, tags: ['z'] });

    expect(db
        .query({ filter: { age: { $gt: 18 } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'c']);
    expect(db
        .query({ filter: { tags: { $contains: 'y' } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b']);
    expect(db
        .query({ filter: { $or: [{ age: { $lt: 18 } }, { name: 'Eve' }] } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['b', 'c']);
    expect(db.query({ filter: { name: { $regex: '^A' } } }).map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('query composes dt range + value filter + sort + limit + project', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    for (let i = 1; i <= 10; i++) {
      await db.set(
        `p${i}`,
        { age: i * 5, city: i % 2 ? 'Paris' : 'London' },
        { dt: { ts: i * 1000 } },
      );
    }
    const res = db.query({
      dt: { ts: { gte: 3000, lte: 8000 } },
      filter: { city: 'Paris' },
      sort: { age: -1 },
      limit: 2,
      project: ['age'],
    });
    // ts in [3000,8000] => i=3..8; Paris (odd i) => 3,5,7; sort age desc => 7(35),5(25)
    expect(res.map((r) => r.key)).toStrictEqual(['p7', 'p5']);
    expect(res[0].value).toStrictEqual({ age: 35 }); // projected
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dt-ordered limit fast path matches a reference (no ties)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byRole', { field: 'role' });
    const docs: { key: string; role: string; n: number; ts: number }[] = [];
    for (let i = 1; i <= 20; i++) {
      const ts = i * 100; // unique
      const role = i % 2 ? 'user' : 'assistant';
      await db.set(`d${i}`, { role, n: i }, { dt: { ts } });
      docs.push({ key: `d${i}`, role, n: i, ts });
    }
    const gte = 200;
    const lte = 1500;

    const refDesc = docs
      .filter((d) => d.role === 'user' && d.ts >= gte && d.ts <= lte)
      .toSorted((a, b) => b.ts - a.ts);

    // sort by dt desc + limit -> fast path
    expect(db
        .query({ dt: { ts: { gte, lte } }, filter: { role: 'user' }, sort: { ts: -1 }, limit: 3 })
        .map((r) => r.key)).toStrictEqual(refDesc.slice(0, 3).map((d) => d.key));
    // ascending + skip + limit -> fast path
    const refAsc = [...refDesc].toReversed();
    expect(db
        .query({
          dt: { ts: { gte, lte } },
          filter: { role: 'user' },
          sort: { ts: 1 },
          skip: 1,
          limit: 2,
        })
        .map((r) => r.key)).toStrictEqual(refAsc.slice(1, 3).map((d) => d.key));
    // no sort -> defaults to dt ascending, still fast path
    expect(db.query({ dt: { ts: { gte, lte } }, filter: { role: 'user' }, limit: 2 }).map((r) => r.key)).toStrictEqual(refAsc.slice(0, 2).map((d) => d.key));
    // project still applies on the fast path
    const proj = db.query({
      dt: { ts: { gte, lte } },
      filter: { role: 'user' },
      sort: { ts: -1 },
      limit: 1,
      project: ['n'],
    });
    expect(proj[0]).toStrictEqual({
      key: refDesc[0]!.key,
      value: { n: refDesc[0]!.n },
      dt: { ts: refDesc[0]!.ts },
    });
    // sort by a non-dt field -> falls back to general path (still correct)
    // n == i order matches ts here
    expect(
      db
        .query({ dt: { ts: { gte, lte } }, filter: { role: 'user' }, sort: { n: -1 }, limit: 3 })
        .map((r) => r.key),
    ).toStrictEqual(refDesc.slice(0, 3).map((d) => d.key));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dt-ordered limit fast path orders equal ts by key (tie-break)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    // several docs share the same ts; SkipList tie-break is by record key
    for (const k of ['t3', 't1', 't4', 't2']) await db.set(k, { v: k }, { dt: { ts: 1000 } });
    // descending -> key desc; ascending -> key asc
    expect(db
        .query({ dt: { ts: { gte: 1000, lte: 1000 } }, sort: { ts: -1 }, limit: 4 })
        .map((r) => r.key)).toStrictEqual(['t4', 't3', 't2', 't1']);
    expect(db
        .query({ dt: { ts: { gte: 1000, lte: 1000 } }, sort: { ts: 1 }, limit: 2 })
        .map((r) => r.key)).toStrictEqual(['t1', 't2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('full-text search: latin + CJK', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('bio', { fields: ['bio'] });
    await db.set('a', { bio: 'hello world from London' });
    await db.set('b', { bio: '我住在北京，喜欢编程' });
    await db.set('c', { bio: '我在上海写代码' });

    const latin = db.search('bio', 'hello').map((r) => r.key);
    expect(latin).toStrictEqual(['a']);

    const cjk = db.search('bio', '北京').map((r) => r.key);
    expect(cjk).toStrictEqual(['b']);

    const or = db
      .search('bio', '北京 上海', { op: 'OR' })
      .map((r) => r.key)
      .toSorted();
    expect(or).toStrictEqual(['b', 'c']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('text index persists + rebuilds across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('bio', { fields: ['bio'] });
    await db.set('a', { bio: '我爱北京天安门' });
    await db.set('b', { bio: '今天天气不错' });
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    expect(db.search('bio', '北京').map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('query composes key prefix + text + filter', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('body');
    await db.set('post:1', { title: 'Redis 持久化详解', tag: 'db' });
    await db.set('post:2', { title: 'Node 事件循环', tag: 'js' });
    await db.set('note:1', { title: 'Redis 笔记', tag: 'db' });

    const res = db.query({
      key: { prefix: 'post:' },
      text: { index: 'body', q: 'Redis' },
      filter: { tag: 'db' },
    });
    expect(res.map((r) => r.key)).toStrictEqual(['post:1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('query uses value indexes for equality/range filters', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    await db.set('a', { city: 'Paris', age: 30 });
    await db.set('b', { city: 'Paris', age: 17 });
    await db.set('c', { city: 'London', age: 41 });

    expect(db
        .query({ filter: { city: 'Paris' } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b']);
    expect(db
        .query({ filter: { age: { $gte: 30 } } })
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'c']);
    expect(db.query({ filter: { $and: [{ city: 'Paris' }, { age: { $gte: 18 } }] } }).map((r) => r.key)).toStrictEqual(['a']);
    expect(db.stats.queryIndexHits >= 3).toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
