// test/e2e/index-consistency.test.ts
//
// Verify that all derived indexes (key order, dt, value secondary, full-text)
// stay consistent with the primary store under random operations, including
// after an index rebuild on reopen.


import { expect, test } from 'bun:test';

import { UniqueViolationError } from '../../src/index-manager.js';
import { MiniDb } from '../../src/index.js';
import { mulberry32, randInt, pick } from './helpers/prng.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

const CITIES = ['Paris', 'London', 'Tokyo', 'Beijing'];
const BIOS = [
  'hello world',
  'foo bar baz',
  '我住在北京 喜欢编程',
  'database engine rocks',
  'lark approval skill',
];

function randomDoc(rng) {
  return {
    city: pick(rng, CITIES),
    age: randInt(rng, 60),
    email: 'u' + randInt(rng, 100000) + '@example.test',
    bio: pick(rng, BIOS),
  };
}

test(
  'index-consistency: indexes stay consistent with the store under random ops',
  { timeout: 60_000 },
  async () => {
    const rng = mulberry32(0x5eed1234);
    const dir = await tmpDir();
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createIndex('byCity', { field: 'city' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    await db.createIndex('byEmail', { field: 'email', unique: true });
    await db.createTextIndex('body', { fields: ['bio'] });
    // A second text index and a compound index exercise the shared rebuild
    // walk's fan-out (one decode per record feeding every staged builder).
    await db.createTextIndex('cityText', { fields: ['city'] });
    await db.createCompoundIndex('byCityAge', { groupBy: 'city', orderBy: 'age' });

    const live = new Map(); // key -> doc (reference of live docs)
    try {
      for (let i = 0; i < 800; i++) {
        const key = 'u' + randInt(rng, 80);
        if (rng() < 0.75) {
          const doc = randomDoc(rng);
          try {
            await db.set(key, doc, { dt: { created: randInt(rng, 1_000_000) } });
            live.set(key, doc);
          } catch (error) {
            if (!(error instanceof UniqueViolationError)) throw error;
            // unique-email collision: write rejected, live unchanged
          }
        } else {
          await db.del(key);
          live.delete(key);
        }
      }

      const expectedKeys = [...live.keys()].toSorted();

      // 1) key order index
      expect(db.scan().map((r) => r.key), 'key order scan').toStrictEqual(expectedKeys);

      // 2) equality index
      for (const city of CITIES) {
        const fromIdx = db
          .findEq('byCity', city)
          .map((r) => r.key)
          .toSorted();
        const expected = [...live.entries()]
          .filter(([, d]) => d.city === city)
          .map(([k]) => k)
          .toSorted();
        expect(fromIdx, `byCity ${city}`).toStrictEqual(expected);
      }

      // 3) range index
      const [min, max] = [20, 40];
      const fromRange = db
        .findRange('byAge', { min, max })
        .map((r) => r.key)
        .toSorted();
      const expectedRange = [...live.entries()]
        .filter(([, d]) => d.age >= min && d.age <= max)
        .map(([k]) => k)
        .toSorted();
      expect(fromRange, 'byAge range').toStrictEqual(expectedRange);

      // 4) dt index
      expect(db
          .dtRange('created', { gte: 0 })
          .map((r) => r.key)
          .toSorted(), 'dt created all').toStrictEqual(expectedKeys);

      // 5) text index: search results == docs whose bio contains the term
      const term = '北京';
      const hits = db
        .search('body', term, { limit: 1000 })
        .map((r) => r.key)
        .toSorted();
      const expectedHits = [...live.entries()]
        .filter(([, d]) => d.bio.includes(term))
        .map(([k]) => k)
        .toSorted();
      expect(hits, 'text search 北京').toStrictEqual(expectedHits);

      // 5b) second text index over the city field
      const cityHits = db
        .search('cityText', 'Paris', { limit: 1000 })
        .map((r) => r.key)
        .toSorted();
      const expectedCityHits = [...live.entries()]
        .filter(([, d]) => d.city === 'Paris')
        .map(([k]) => k)
        .toSorted();
      expect(cityHits, 'text search city=Paris').toStrictEqual(expectedCityHits);

      // 5c) compound index: group ordered by (age, key)
      const parisOrdered = db.compoundRange('byCityAge', 'Paris').map((r) => r.key);
      const expectedParis = [...live.entries()]
        .filter(([, d]) => d.city === 'Paris')
        .toSorted((a, b) => a[1].age - b[1].age || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k]) => k);
      expect(parisOrdered, 'compound Paris ordered by age').toStrictEqual(expectedParis);

      // 6) after rebuild on reopen, indexes still match
      await db.close();
      db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
      const fromIdx2 = db
        .findEq('byCity', 'Paris')
        .map((r) => r.key)
        .toSorted();
      const expected2 = [...live.entries()]
        .filter(([, d]) => d.city === 'Paris')
        .map(([k]) => k)
        .toSorted();
      expect(fromIdx2, 'byCity Paris after rebuild').toStrictEqual(expected2);
      expect(db.scan().map((r) => r.key), 'key order after rebuild').toStrictEqual(expectedKeys);
      // The shared rebuild walk fanned out to every staged builder: all derived
      // index families match the reference model again after reopen.
      expect(db
          .search('cityText', 'Paris', { limit: 1000 })
          .map((r) => r.key)
          .toSorted(), 'cityText Paris after rebuild').toStrictEqual(expectedCityHits);
      expect(db
          .search('body', term, { limit: 1000 })
          .map((r) => r.key)
          .toSorted(), 'text search 北京 after rebuild').toStrictEqual(expectedHits);
      expect(db.compoundRange('byCityAge', 'Paris').map((r) => r.key), 'compound Paris after rebuild').toStrictEqual(expectedParis);
      expect(db
          .dtRange('created', { gte: 0 })
          .map((r) => r.key)
          .toSorted(), 'dt after rebuild').toStrictEqual(expectedKeys);
    } finally {
      await db.close().catch(() => {});
      await rmrf(dir);
    }
  },
);
