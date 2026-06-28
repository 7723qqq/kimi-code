// test/query.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-query-'));
}

test('key range + prefix scan', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    for (const k of ['user:3', 'user:1', 'user:2', 'order:1']) await db.set(k, k);
    assert.deepEqual(db.scan({ gte: 'user:', lte: 'user:~' }).map((r) => r.key), [
      'user:1',
      'user:2',
      'user:3',
    ]);
    assert.deepEqual(db.prefix('user:').map((r) => r.key), ['user:1', 'user:2', 'user:3']);
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

    assert.deepEqual(db.dtColumns().sort(), ['created']);
    const rows = db.dtRange('created', { gte: jan, lte: mar });
    assert.deepEqual(rows.map((r) => r.key), ['a', 'b']);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.dtRange('created', { gt: mar }).map((r) => r.key), ['c']);
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

    assert.deepEqual(
      db.query({ filter: { age: { $gt: 18 } } }).map((r) => r.key).sort(),
      ['a', 'c'],
    );
    assert.deepEqual(
      db.query({ filter: { tags: { $contains: 'y' } } }).map((r) => r.key).sort(),
      ['a', 'b'],
    );
    assert.deepEqual(
      db.query({ filter: { $or: [{ age: { $lt: 18 } }, { name: 'Eve' }] } }).map((r) => r.key).sort(),
      ['b', 'c'],
    );
    assert.deepEqual(
      db.query({ filter: { name: { $regex: '^A' } } }).map((r) => r.key),
      ['a'],
    );
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
      await db.set(`p${i}`, { age: i * 5, city: i % 2 ? 'Paris' : 'London' }, { dt: { ts: i * 1000 } });
    }
    const res = db.query({
      dt: { ts: { gte: 3000, lte: 8000 } },
      filter: { city: 'Paris' },
      sort: { age: -1 },
      limit: 2,
      project: ['age'],
    });
    // ts in [3000,8000] => i=3..8; Paris (odd i) => 3,5,7; sort age desc => 7(35),5(25)
    assert.deepEqual(res.map((r) => r.key), ['p7', 'p5']);
    assert.deepEqual(res[0].value, { age: 35 }); // projected
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
    assert.deepEqual(latin, ['a']);

    const cjk = db.search('bio', '北京').map((r) => r.key);
    assert.deepEqual(cjk, ['b']);

    const or = db.search('bio', '北京 上海', { op: 'OR' }).map((r) => r.key).sort();
    assert.deepEqual(or, ['b', 'c']);
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
    assert.deepEqual(db.search('bio', '北京').map((r) => r.key), ['a']);
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
    assert.deepEqual(res.map((r) => r.key), ['post:1']);
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

    assert.deepEqual(db.query({ filter: { city: 'Paris' } }).map((r) => r.key).sort(), ['a', 'b']);
    assert.deepEqual(db.query({ filter: { age: { $gte: 30 } } }).map((r) => r.key).sort(), ['a', 'c']);
    assert.deepEqual(
      db.query({ filter: { $and: [{ city: 'Paris' }, { age: { $gte: 18 } }] } }).map((r) => r.key),
      ['a'],
    );
    assert.ok(db.stats.queryIndexHits >= 3);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
