// test/text-index.test.ts
//
// Larger-than-RAM full-text index: postings codec, on-disk postings file, and
// the TextIndex (delta + tombstones + disk-backed base + cache).

import { expect, test } from 'bun:test';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MiniDb } from '../src/index.js';
import { TextIndex, TextIndexBuildingError, tokenize } from '../src/text-index/index.js';
import {
  encodePostingList,
  decodePostingList,
  encodeRecord,
  decodeRecord,
  PostingsFile,
} from '../src/text-postings.js';
import { normalizeLiteral, ngramTerm, createNgramTokenizer } from '../src/trigram.js';
import { barrier } from './helpers.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-text-'));
}

/** A replace-rename that refuses ONE destination with EPERM but succeeds on
 *  any other name — the exact shape the retired EPERM fallback exploited by
 *  retrying onto a suffixed path. */
function epermOn(fixedDst: string): (src: string, dst: string) => Promise<void> {
  return (src, dst) => {
    if (dst === fixedDst) {
      const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      return Promise.reject(e);
    }
    return fs.rename(src, dst);
  };
}

// ---- codec ---------------------------------------------------------------

test('postings codec: roundtrip + delta compression', () => {
  const entries: [number, number][] = [
    [0, 1],
    [3, 2],
    [10, 5],
    [1000, 1],
    [40000, 7],
  ];
  const enc = encodePostingList(entries);
  expect(decodePostingList(enc)).toStrictEqual(entries);
  // delta+varint should beat a naive 8 bytes/pair for dense-ish ids.
  expect(enc.length < entries.length * 8, `expected compression, got ${enc.length} bytes`).toBeTruthy();
});

test('postings codec: empty list', () => {
  expect(decodePostingList(encodePostingList([]))).toStrictEqual([]);
});

test('record frame: CRC detects corruption', () => {
  const payload = encodePostingList([
    [1, 1],
    [2, 3],
  ]);
  const rec = encodeRecord('hello', 2, payload);
  const good = decodeRecord(rec);
  expect(good.term).toBe('hello');
  expect(good.df).toBe(2);
  expect(decodePostingList(good.payload)).toStrictEqual([
    [1, 1],
    [2, 3],
  ]);

  const bad = Buffer.from(rec);
  bad[2] ^= 0xff; // flip a byte inside the term
  expect(() => decodeRecord(bad)).toThrow(/crc mismatch/);
});

// ---- PostingsFile --------------------------------------------------------

test('PostingsFile: rebuild + positioned read', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 'x.postings');
    const { dict } = await PostingsFile.rebuild(p, [
      {
        term: 'hello',
        entries: [
          [0, 1],
          [5, 2],
          [9, 1],
        ],
      },
      {
        term: '北京',
        entries: [
          [1, 3],
          [2, 1],
        ],
      },
      { term: 'empty', entries: [] }, // must be skipped
    ]);
    expect(dict.size).toBe(2);
    expect(!dict.has('empty')).toBeTruthy();

    const pf = PostingsFile.open(p);
    expect(pf.read(dict.get('hello')!)).toStrictEqual([
      [0, 1],
      [5, 2],
      [9, 1],
    ]);
    expect(pf.read(dict.get('北京')!)).toStrictEqual([
      [1, 3],
      [2, 1],
    ]);
    pf.close();

    // rebuild is atomic: a second rebuild replaces the file and dict.
    const { dict: dict2 } = await PostingsFile.rebuild(p, [{ term: 'only', entries: [[7, 1]] }]);
    expect(dict2.size).toBe(1);
    const pf2 = PostingsFile.open(p);
    expect(pf2.read(dict2.get('only')!)).toStrictEqual([[7, 1]]);
    pf2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PostingsFile: corrupt record throws on read', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 'x.postings');
    const { dict } = await PostingsFile.rebuild(p, [{ term: 'a', entries: [[1, 1]] }]);
    // flip a byte in the file payload
    const e = dict.get('a')!;
    const fd = fssync.openSync(p, 'r+');
    fssync.writeSync(fd, Buffer.from([0xff]), 0, 1, e.off + Math.floor(e.len / 2));
    fssync.closeSync(fd);

    const pf = PostingsFile.open(p);
    expect(() => pf.read(e)).toThrow(/crc mismatch/);
    pf.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- TextIndex (direct, disk-backed) -------------------------------------

test('TextIndex: add + search (AND/OR) disk-backed', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world from London' });
    ti.add('b', { bio: '我住在北京，喜欢编程' });
    ti.add('c', { bio: '我在上海写代码' });

    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);
    expect(ti.search('北京').map((h) => h.key)).toStrictEqual(['b']);
    expect(ti
        .search('北京 上海', { op: 'OR' })
        .map((h) => h.key)
        .toSorted()).toStrictEqual(['b', 'c']);
    // AND across two terms only present together in 'b'
    expect(ti.search('北京 编程').map((h) => h.key)).toStrictEqual(['b']);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: overwrite tombstones old postings', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world' });
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);
    // overwrite 'a' with different text -> old 'hello' posting must be gone
    ti.add('a', { bio: 'goodbye world' });
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual([]);
    expect(ti.search('goodbye').map((h) => h.key)).toStrictEqual(['a']);
    expect(ti.N).toBe(1);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: remove deletes postings', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world' });
    ti.add('b', { bio: 'hello there' });
    ti.remove('a');
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['b']);
    expect(ti.N).toBe(1);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: build persists to disk + merges delta after build', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 't.postings');
    const ti = new TextIndex({ postingsPath: p });
    await ti.build([
      { key: 'a', value: { bio: 'hello world' } },
      { key: 'b', value: { bio: '我住在北京' } },
    ]);
    expect(fssync.existsSync(p), 'postings file should exist after build').toBeTruthy();
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);

    // new writes after build go to the in-memory delta and are still found
    ti.add('c', { bio: 'hello from c' });
    expect(ti
        .search('hello')
        .map((h) => h.key)
        .toSorted()).toStrictEqual(['a', 'c']);
    ti.close();

    // a fresh TextIndex over the same file sees the base but not the lost delta
    // (delta is volatile by design; the db rebuilds from the Store on open).
    const ti2 = new TextIndex({ postingsPath: p });
    // rebuild base from the file's perspective by re-reading the same entries
    await ti2.build([
      { key: 'a', value: { bio: 'hello world' } },
      { key: 'b', value: { bio: '我住在北京' } },
    ]);
    expect(ti2.search('hello').map((h) => h.key)).toStrictEqual(['a']);
    ti2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: writes landing mid-build are replayed onto the new base', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 't.postings');
    const ti = new TextIndex({ postingsPath: p });
    // More docs than BUILD_YIELD_DOCS (512), so the build is guaranteed to
    // yield at least once before its swap — the setImmediate below then lands
    // strictly inside the build window.
    const docs = Array.from({ length: 3000 }, (_, i) => ({
      key: `d${i}`,
      value: { bio: `hello doc${i}` },
    }));
    const buildP = ti.build(docs);
    let landedMidBuild = false;
    setImmediate(() => {
      landedMidBuild = ti.building;
      ti.add('extra', { bio: 'hello extra' }); // new key
      ti.add('d0', { bio: 'goodbye replaced' }); // overwrite a staged key
      ti.remove('d1'); // delete a staged key
    });
    await buildP;
    expect(landedMidBuild, 'writes landed while the build was in flight').toBeTruthy();

    // Live view during the build stayed correct, and the queue replay made
    // the new base exact: 3000 staged + extra − replaced-d0 − removed-d1.
    expect(ti.N).toBe(3000);
    expect(ti.search('extra').map((h) => h.key)).toStrictEqual(['extra']);
    expect(ti.search('goodbye').map((h) => h.key)).toStrictEqual(['d0']);
    expect(ti.search('doc1').map((h) => h.key)).toStrictEqual([]);
    expect(ti.search('hello', { limit: 10_000 }).length).toBe(2999);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: memory-only mode (no postingsPath)', () => {
  const ti = new TextIndex(); // memory base
  ti.add('a', { bio: 'hello world' });
  ti.add('b', { bio: '北京天安门' });
  expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);
  expect(ti.search('北京').map((h) => h.key)).toStrictEqual(['b']);
  expect(ti.termCount() > 0).toBe(true);
  ti.close();
});

test('TextIndex: default tokenizer NFKC-folds fullwidth latin so halfwidth queries hit', () => {
  const ti = new TextIndex(); // memory base
  ti.add('a', { bio: 'ＫＩＭＩ ｃｏｄｅ' });
  ti.add('b', { bio: '北京天安门' });
  expect(ti.search('kimi').map((h) => h.key)).toStrictEqual(['a']);
  expect(ti.search('code').map((h) => h.key)).toStrictEqual(['a']);
  expect(ti.search('北京').map((h) => h.key)).toStrictEqual(['b']);
  ti.close();
});

// ---- through MiniDb ------------------------------------------------------

test('MiniDb: text postings written to disk, search survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('bio', { fields: ['bio'] });
    await db.set('a', { bio: '我爱北京天安门' });
    await db.set('b', { bio: '今天天气不错' });
    await db.close();

    expect(fssync.existsSync(path.join(dir, 'db.text-bio.postings')), 'postings file exists').toBeTruthy();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    expect(db.search('bio', '北京').map((r) => r.key)).toStrictEqual(['a']);
    // overwrite then reopen -> tombstone must not resurrect old text
    await db.set('a', { bio: '我爱上海' });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    expect(db.search('bio', '北京').map((r) => r.key)).toStrictEqual([]);
    expect(db.search('bio', '上海').map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const indexGenerations of [false, true]) {
  test(`MiniDb: compaction rebuilds postings (file reclaimed) [indexGenerations: ${indexGenerations}]`, async () => {
    const dir = await tmpDir();
    try {
      const db = await MiniDb.open({
        dir,
        valueCodec: 'json',
        autoCompact: false,
        indexGenerations,
      });
      await db.createTextIndex('bio', { fields: ['bio'] });
      for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'hello world ' + i });
      const p = path.join(dir, 'db.text-bio.postings');
      if (indexGenerations) {
        // The background generation build may already have re-published the
        // base (root file reclaimed) — either location proves persistence.
        const inGen = fssync.existsSync(path.join(dir, 'CURRENT'));
        expect(fssync.existsSync(p) || inGen, 'postings persisted (root or generation)').toBeTruthy();
      } else {
        expect(fssync.existsSync(p)).toBeTruthy();
      }
      // overwrite everything to create tombstones, then add more (delta grows)
      for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'goodbye world ' + i });
      for (let i = 50; i < 80; i++) await db.set('k' + i, { bio: 'hello again ' + i });

      await db.compact(); // should rebuild postings from the live store

      // after compaction the postings reflect the latest values only
      expect(db.search('bio', 'hello').length).toBe(30); // k50..k79
      expect(db.search('bio', 'goodbye').length).toBe(50); // k0..k49
      if (indexGenerations) {
        // The base moved into the published generation: the legacy root file
        // is reclaimed and CURRENT's generation carries the fresh postings.
        expect(!fssync.existsSync(p), 'root postings reclaimed after generation publish').toBeTruthy();
        const gen = db.getIndexGeneration()!;
        expect(gen, 'compaction published a generation').toBeTruthy();
        expect(fssync.existsSync(path.join(dir, 'generations', gen.id, 'text-bio.postings')), 'postings live in the generation').toBeTruthy();
      } else {
        expect(fssync.existsSync(p), 'legacy path keeps the root postings file').toBeTruthy();
      }
      await db.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('MiniDb: compaction skips the postings rebuild when the index is clean [legacy]', async () => {
  const dir = await tmpDir();
  // Count TextIndex.build calls to prove which compactions rebuilt postings.
  const orig = TextIndex.prototype.build;
  let builds = 0;
  TextIndex.prototype.build = async function (this: TextIndex, ...args) {
    builds++;
    return orig.apply(this, args);
  } as typeof orig;
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'json',
      autoCompact: false,
      indexGenerations: false,
    });
    await db.createTextIndex('bio', { fields: ['bio'] }); // build #1
    await db.set('a', { bio: 'hello world' });
    await db.compact(); // delta dirty -> rebuild #2
    await db.compact(); // clean now -> rebuild skipped
    expect(builds).toBe(2);
    expect(db.search('bio', 'hello').map((h) => h.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    TextIndex.prototype.build = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: compaction skips the postings rebuild when the index is clean [generation]', async () => {
  const dir = await tmpDir();
  // Same skip, generation style: the clean index is re-published by hard
  // link, so PostingsFile.rebuild (the actual postings rewrite) runs only
  // for the create and the one DIRTY compaction.
  const orig = PostingsFile.rebuild;
  let rebuilds = 0;
  PostingsFile.rebuild = async function (...args) {
    rebuilds++;
    return orig.apply(this, args);
  } as typeof orig;
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] }); // rewrite #1
    await db.set('a', { bio: 'hello world' });
    await db.compact(); // delta dirty -> generation build rewrites postings (#2)
    await db.compact(); // clean now -> re-published by link, no rewrite
    expect(rebuilds).toBe(2);
    expect(db.search('bio', 'hello').map((h) => h.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    PostingsFile.rebuild = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: a generation build leaves the non-override rebuild target intact [generation]', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] });
    await db.set('a', { bio: 'hello alpha' });
    // Generation build: its staged postings write is redirected into the
    // generation's tmp directory, which the publish rename then takes away.
    await db.compact();
    const ti = (db as unknown as { text: Map<string, TextIndex> }).text.get('bio')!;
    expect(ti.currentPostingsPath?.includes('generations'), `expected the live base inside a generation, got ${ti.currentPostingsPath}`).toBeTruthy();

    // A later NON-override rebuild (the legacy postings maintenance path) must
    // still target the index's own root postings file — never the vanished
    // generation tmp path, which would fail ENOENT for every rebuild.
    await db.set('b', { bio: 'hello beta' });
    const priv = db as unknown as { textRegistry: { rebuildTextPostings(): Promise<void> } };
    await priv.textRegistry.rebuildTextPostings();

    const rootPostings = path.join(dir, 'db.text-bio.postings');
    expect(ti.currentPostingsPath).toBe(rootPostings);
    expect(fssync.existsSync(rootPostings), 'postings landed in the expected directory').toBe(true);
    expect(db.search('bio', 'hello', { limit: 10 }).map((h) => h.key)).toStrictEqual(['a', 'b']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const indexGenerations of [false, true]) {
  test(`MiniDb: writes during a compaction postings rebuild stay consistent [indexGenerations: ${indexGenerations}]`, async () => {
    const dir = await tmpDir();
    // Deterministic barrier instead of the old "3000 docs keep the compaction
    // busy long enough" timing inference (review #28): the compaction's
    // derived-state rebuild is parked on a deferred, so the writes PROVABLY
    // land while it is in flight, and each write's promise is explicitly
    // settled instead of fire-and-forget. The barrier arms AFTER
    // createTextIndex so its call 1 is the compaction rebuild, not the
    // create. On the legacy path the rebuild is TextIndex.build; with
    // generations it is the staged build's PostingsFile.rebuild inside the
    // generation publish.
    let gate!: ReturnType<typeof barrier>;
    try {
      const db = await MiniDb.open({
        dir,
        valueCodec: 'json',
        autoCompact: false,
        indexGenerations,
      });
      await db.createTextIndex('bio', { fields: ['bio'] });
      for (let i = 0; i < 50; i++) await db.set(`d${i}`, { bio: `hello doc${i}` });

      gate = indexGenerations
        ? barrier(PostingsFile, 'rebuild')
        : barrier(TextIndex.prototype, 'build');
      const compactP = db.compact();
      await gate.entered; // the compaction is provably inside the postings rebuild
      const writes = Promise.all([
        db.set('extra', { bio: 'hello extra' }),
        db.set('d0', { bio: 'goodbye replaced' }),
        db.del('d1'),
      ]);
      gate.release();
      await writes;
      await compactP;
      expect(db.stats.compactions).toBe(1);

      expect(db.search('bio', 'hello', { limit: 10_000 }).length).toBe(49);
      expect(db.search('bio', 'extra').map((h) => h.key)).toStrictEqual(['extra']);
      expect(db.search('bio', 'goodbye').map((h) => h.key)).toStrictEqual(['d0']);
      expect(db.search('bio', 'doc1').map((h) => h.key)).toStrictEqual([]);
      await db.close();

      // The mid-compaction writes are durable and consistent across a reopen.
      const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
      expect(db2.search('bio', 'hello', { limit: 10_000 }).length).toBe(49);
      expect(db2.search('bio', 'extra').map((h) => h.key)).toStrictEqual(['extra']);
      await db2.close();
    } finally {
      gate?.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

// ---- trigram (n-gram literal tokenizer) ------------------------------------

test('trigram: normalization (case, NFKC, code points)', () => {
  expect(normalizeLiteral('AbC')).toBe('abc');
  // NFKC folds compatibility glyphs: fullwidth dollar -> ascii dollar
  expect(normalizeLiteral('＄100')).toBe('$100');
  // surrogate pairs count as one code point and survive normalization
  expect(Array.from(normalizeLiteral('A🙂')).length).toBe(2);
  expect(normalizeLiteral('🙂')).toBe('🙂');
});

test('trigram: hash terms are stable and width-tagged', () => {
  // crc32 of the utf8 bytes, low 22 bits, base 36 — pinned so every process
  // derives the same term for the same n-gram.
  expect(ngramTerm('ab')).toBe('24m0d');
  expect(ngramTerm('abc')).toBe('31exfm');
  expect(ngramTerm('🚀🎉')).toBe('217syy');
  // 2-grams and 3-grams live in different tag namespaces and can never alias
  expect(ngramTerm('ab').startsWith('2')).toBeTruthy();
  expect(ngramTerm('abc').startsWith('3')).toBeTruthy();
  expect(ngramTerm('ab')).not.toBe(ngramTerm('abc'));
  expect(() => ngramTerm('a')).toThrow(/2- or 3-gram/);
});

test('trigram: index vs query tokenizer shapes', () => {
  const ix = createNgramTokenizer();
  const q = createNgramTokenizer({ forQuery: true });
  // shorter than 2 normalized code points -> no terms (upper layer rejects)
  expect(q('a')).toStrictEqual([]);
  expect(ix('a')).toStrictEqual([]);
  expect(q('')).toStrictEqual([]);
  // length 2: both sides emit exactly the one 2-gram
  expect(q('AB')).toStrictEqual([ngramTerm('ab')]);
  expect(ix('AB')).toStrictEqual([ngramTerm('ab')]);
  // length >= 3: query side only 3-grams; index side 3-grams + 2-grams
  expect(q('abcd')).toStrictEqual([ngramTerm('abc'), ngramTerm('bcd')]);
  expect(ix('abcd').toSorted()).toStrictEqual([
      ngramTerm('ab'),
      ngramTerm('abc'),
      ngramTerm('bc'),
      ngramTerm('bcd'),
      ngramTerm('cd'),
    ].toSorted());
  // emoji are single code points: '🙂a' has length 2 -> one 2-gram, not a
  // 3-gram over split UTF-16 surrogates
  expect(q('🙂a')).toStrictEqual([ngramTerm('🙂a')]);
});

test('trigram: normalization can change length (single ligature ﬀ becomes a legal query)', () => {
  // 'ﬀ' (U+FB00) is one code point, but NFKC folds it to 'ff' — so the query
  // side emits exactly one 2-gram and the search layer's >=2 check (judged
  // after normalization) accepts what looks like a 1-character query.
  expect(normalizeLiteral('ﬀ')).toBe('ff');
  expect(createNgramTokenizer({ forQuery: true })('ﬀ')).toStrictEqual([ngramTerm('ff')]);
});

test('trigram: query of exactly 3 code points emits its single 3-gram', () => {
  const q = createNgramTokenizer({ forQuery: true });
  // the boundary where the query side switches from 2-grams to 3-grams
  expect(q('abc')).toStrictEqual([ngramTerm('abc')]);
  expect(q('已通过')).toStrictEqual([ngramTerm('已通过')]);
  // the index side of a 3-char text still emits both widths
  expect(createNgramTokenizer()('abc').toSorted()).toStrictEqual([ngramTerm('abc'), ngramTerm('ab'), ngramTerm('bc')].toSorted());
});

test('TextIndex: injected n-gram tokenizer matches symbol substrings', async () => {
  const dir = await tmpDir();
  try {
    // Wired the same way MiniDb.createTextIndex(..., { tokenizer: 'ngram' })
    // does: index side both widths, query side forQuery.
    const ti = new TextIndex({
      postingsPath: path.join(dir, 'tri.postings'),
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
    });
    ti.add('cpp', { text: 'modern C++ patterns' });
    ti.add('arrow', { text: 'rewrite a->b safely' });
    ti.add('dash', { text: 'a-b is not an arrow' }); // shares 'a-' but has no '->'
    ti.add('done', { text: '检查项 **已通过** 审核' });
    ti.add('latex', { text: 'inline math $\\frac{a}{b}$ here' });
    ti.add('emoji', { text: 'launch 🚀🎉 today' });

    expect(ti.search('C++').map((h) => h.key)).toStrictEqual(['cpp']);
    expect(ti.search('c++').map((h) => h.key)).toStrictEqual(['cpp']); // case-insensitive
    expect(ti.search('->').map((h) => h.key)).toStrictEqual(['arrow']); // 2-char query via 2-gram
    expect(ti.search('a->b').map((h) => h.key)).toStrictEqual(['arrow']); // distractor 'a-b' excluded
    expect(ti.search('已通过').map((h) => h.key)).toStrictEqual(['done']);
    expect(ti.search('\\frac{a}{b}').map((h) => h.key)).toStrictEqual(['latex']);
    expect(ti.search('🚀🎉').map((h) => h.key)).toStrictEqual(['emoji']);
    // single character yields no terms, hence no hits
    expect(ti.search('a')).toStrictEqual([]);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: n-gram tokenizer delta add/remove/overwrite', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({
      postingsPath: path.join(dir, 'tri.postings'),
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
    });
    await ti.build([{ key: 'a', value: { text: 'C++ guide' } }]);
    expect(ti.search('c++').map((h) => h.key)).toStrictEqual(['a']);

    // writes after build land in the delta and stay searchable
    ti.add('b', { text: 'C++ cookbook' });
    expect(ti
        .search('c++')
        .map((h) => h.key)
        .toSorted()).toStrictEqual(['a', 'b']);

    ti.remove('a');
    expect(ti.search('c++').map((h) => h.key)).toStrictEqual(['b']);
    expect(ti.N).toBe(1);

    // overwrite tombstones the old n-grams
    ti.add('b', { text: 'plain c guide' });
    expect(ti.search('c++').map((h) => h.key)).toStrictEqual([]);
    expect(ti.search('c guide').map((h) => h.key)).toStrictEqual(['b']);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: queryTokenizer tokenizes searches when given, falls back otherwise', async () => {
  const dir = await tmpDir();
  try {
    // Docs are indexed under the index tokenizer's term; a search must
    // consult the QUERY tokenizer's term instead.
    const ti = new TextIndex({
      postingsPath: path.join(dir, 't.postings'),
      tokenizer: () => ['idx-term'],
      queryTokenizer: () => ['query-term'],
    });
    ti.add('a', { text: 'whatever' });
    expect(ti.search('anything')).toStrictEqual([]); // looks up 'query-term', never indexed
    ti.close();

    // Without a queryTokenizer, search falls back to the index tokenizer.
    const fallback = new TextIndex({
      postingsPath: path.join(dir, 't2.postings'),
      tokenizer: () => ['idx-term'],
    });
    fallback.add('a', { text: 'whatever' });
    expect(fallback.search('anything').map((h) => h.key)).toStrictEqual(['a']);
    fallback.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: n-gram text index tokenizes queries with the forQuery shape', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
    // 'ab only' shares the 2-gram 'ab' with the query 'abc' but none of its
    // 3-grams. Under OR, an index-side query tokenizer (3-grams + 2-grams)
    // would surface it via 'ab'; the forQuery side emits only the 'abc'
    // 3-gram, so nothing matches.
    await db.set('partial', { text: 'ab only' });
    expect(db.search('tri', 'abc', { op: 'OR' })).toStrictEqual([]);
    await db.set('full', { text: 'abc here' });
    expect(db.search('tri', 'abc', { op: 'OR' }).map((r) => r.key)).toStrictEqual(['full']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: n-gram text index persists tokenizer, survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
    await db.createTextIndex('body', { fields: ['text'] });
    await db.set('a', { text: 'modern C++ patterns' });
    await db.set('b', { text: 'plain c plus plus' });
    await db.close();

    // the sidecar records the tokenizer for the n-gram index; the default
    // index keeps the legacy shape (no tokenizer field), which is also what
    // definition files written before n-gram support look like.
    const defs = JSON.parse(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8')) as {
      name: string;
      tokenizer?: string;
    }[];
    expect(defs.find((d) => d.name === 'tri')!.tokenizer).toBe('ngram');
    expect(!('tokenizer' in defs.find((d) => d.name === 'body')!)).toBeTruthy();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    // n-gram index restored as n-gram: 'C++' matches only the real substring
    expect(db.search('tri', 'C++').map((r) => r.key)).toStrictEqual(['a']);
    // default index restored as default: 'C++' still tokenizes to the word 'c'
    expect(db
        .search('body', 'C++')
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'b']);

    // delta writes after reopen use the restored tokenizer too
    await db.set('c', { text: 'another C++ note' });
    expect(db
        .search('tri', 'c++')
        .map((r) => r.key)
        .toSorted()).toStrictEqual(['a', 'c']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: createTextIndex rejects an unknown tokenizer', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await expect(db.createTextIndex('x', { tokenizer: 'bogus' as 'ngram' })).rejects.toThrow(/unknown text index tokenizer/);
    // the failed creation left nothing behind
    expect(() => db.search('x', 'q')).toThrow(/no such text index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- top-K + delta reverse map (plan/02 bounded hot paths) ----------------

test('TextIndex: top-K ranks score desc with a stable key tie-break', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    // Every doc has the same term freq and the same doc length, so all scores
    // are identical and the order must come from the key tie-break alone.
    await ti.build([
      { key: 'k3', value: { bio: 'common pad' } },
      { key: 'k1', value: { bio: 'common pad' } },
      { key: 'k2', value: { bio: 'common pad' } },
    ]);
    expect(ti.search('common', { limit: 2 }).map((h) => h.key), 'equal scores -> key asc').toStrictEqual(['k1', 'k2']);
    expect(ti.search('common', { limit: 10 }).map((h) => h.key)).toStrictEqual(['k1', 'k2', 'k3']);
    expect(ti.search('common', { limit: 0 }), 'limit 0 stays empty').toStrictEqual([]);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: top-K over many candidates matches the full-ranking reference', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    for (let i = 0; i < 500; i++) {
      // Vary both term frequency (i % 7 + 1) and doc length (i % 11 pads), so
      // scores differ across docs; a third of the docs carry no 'x' at all.
      const reps = i % 3 === 0 ? 0 : (i % 7) + 1;
      const body =
        `${'x '.repeat(reps)}${Array.from({ length: i % 11 }, (_, j) => `p${j}`).join(' ')}`.trim();
      entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: body } });
    }
    await ti.build(entries);

    // The full ranking (limit above the candidate count returns everything).
    const all = ti.search('x', { limit: 1_000_000 });
    const matching = entries.filter((e) => e.value.bio.includes('x')).length;
    expect(all.length, 'unbounded search returns every scoring doc').toBe(matching);
    for (let i = 1; i < all.length; i++) {
      const [p, c] = [all[i - 1]!, all[i]!];
      expect(p.score > c.score || (p.score === c.score && p.key < c.key), `rank order at ${i}`).toBeTruthy();
    }
    const rank = new Map(all.map((h, i) => [h.key, i]));
    for (const limit of [1, 5, 10, 50, 499]) {
      const hits = ti.search('x', { limit });
      expect(hits.length).toBe(Math.min(limit, all.length));
      // Exactly the first `limit` rows of the full ranking, in the same order.
      expect(hits.map((h) => h.key), `limit=${limit} is the full ranking's prefix`).toStrictEqual(all.slice(0, limit).map((h) => h.key));
      for (const h of hits) expect(rank.get(h.key)! < limit).toBeTruthy();
    }
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: overwrite/remove prune the delta via the doc reverse map', () => {
  const ti = new TextIndex(); // memory base; adds go to the delta
  ti.add('a', { bio: 'apple banana' });
  ti.add('b', { bio: 'cherry' });
  expect(ti.termCount()).toBe(3);

  ti.add('a', { bio: 'mango' }); // overwrite: apple/banana leave the delta
  expect(ti.search('apple').map((h) => h.key)).toStrictEqual([]);
  expect(ti.search('banana').map((h) => h.key)).toStrictEqual([]);
  expect(ti.search('mango').map((h) => h.key)).toStrictEqual(['a']);
  expect(ti.termCount(), 'pruned terms leave the vocabulary (cherry, mango)').toBe(2);

  ti.remove('b');
  expect(ti.search('cherry').map((h) => h.key)).toStrictEqual([]);
  expect(ti.termCount(), 'only mango remains').toBe(1);
  ti.close();
});

// ---- query-time postings budget (maxVisits / searchBounded) ---------------

test('TextIndex: maxVisits truncates a hot term and reports visits (disk-backed)', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    for (let i = 0; i < 500; i++)
      entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: 'x pad' } });
    await ti.build(entries);

    const full = ti.searchBounded('x', { limit: 1_000 });
    expect(full.hits.length).toBe(500);
    expect(full.truncated).toBe(false);
    expect(full.visits >= 500).toBeTruthy();

    const bounded = ti.searchBounded('x', { limit: 1_000, maxVisits: 100 });
    expect(bounded.truncated, 'the budget cut the hot list short').toBe(true);
    expect(bounded.visits <= 100, `visits stay within the budget, got ${bounded.visits}`).toBeTruthy();
    expect(bounded.hits.length > 0 && bounded.hits.length <= 100).toBeTruthy();
    // A truncated result is a SUBSET of the full matches — never false hits.
    const fullKeys = new Set(full.hits.map((h) => h.key));
    for (const h of bounded.hits) expect(fullKeys.has(h.key), `${h.key} is a real match`).toBeTruthy();

    // The same options through plain search() keep returning just the hits.
    expect(ti.search('x', { limit: 1_000, maxVisits: 100 }).map((h) => h.key)).toStrictEqual(bounded.hits.map((h) => h.key));
    // Unbudgeted callers are unaffected, and a capped read never poisoned the
    // postings cache with a partial list.
    expect(ti.search('x', { limit: 1_000 }).length).toBe(500);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: maxVisits caps the memory base the same way', async () => {
  const ti = new TextIndex(); // memory base
  for (let i = 0; i < 200; i++) ti.add(`k${String(i).padStart(4, '0')}`, { bio: 'x pad' });

  const bounded = ti.searchBounded('x', { limit: 1_000, maxVisits: 50 });
  expect(bounded.truncated).toBe(true);
  expect(bounded.visits <= 50).toBeTruthy();
  expect(bounded.hits.length > 0 && bounded.hits.length <= 50).toBeTruthy();
  expect(ti.search('x', { limit: 1_000 }).length, 'unbudgeted search unaffected').toBe(200);
  ti.close();
});

test('TextIndex: AND under a budget yields a subset with complete per-doc scores', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    // 'hot' appears in 500 docs, 'rare' in 3 of them.
    for (let i = 0; i < 500; i++) {
      const rare = i < 3 ? ' rare' : '';
      entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: `hot pad${rare}` } });
    }
    await ti.build(entries);

    const full = ti.searchBounded('hot rare', { limit: 1_000 });
    expect(full.hits.length).toBe(3);

    // The budget is exhausted by the hot term, but the selective term decodes
    // first; the intersection can only shrink — a subset, never false hits.
    // (Scores under a truncated budget are approximate: idf is computed from
    // the decoded list, whose df the cap shrinks. The `truncated` flag is
    // what tells the caller not to trust completeness.)
    const bounded = ti.searchBounded('hot rare', { limit: 1_000, maxVisits: 60 });
    expect(bounded.truncated).toBe(true);
    const fullKeys = new Set(full.hits.map((h) => h.key));
    expect(bounded.hits.length <= full.hits.length).toBeTruthy();
    for (const h of bounded.hits) {
      expect(fullKeys.has(h.key), `${h.key} is a true AND match`).toBeTruthy();
      expect(h.score > 0).toBeTruthy();
    }

    // A zero budget cannot assemble any AND candidate set: empty + flagged.
    const zero = ti.searchBounded('hot rare', { limit: 1_000, maxVisits: 0 });
    expect(zero.truncated).toBe(true);
    expect(zero.hits.length).toBe(0);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: searchBounded surfaces values, visits and the truncated flag', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no' });
    await db.createTextIndex('body', { fields: ['bio'] });
    for (let i = 0; i < 300; i++) {
      await db.set(`k${String(i).padStart(4, '0')}`, { bio: 'x pad', n: i });
    }

    const bounded = db.searchBounded('body', 'x', { limit: 1_000, maxVisits: 80 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.visits <= 80).toBeTruthy();
    expect(bounded.hits.length > 0 && bounded.hits.length <= 80).toBeTruthy();
    for (const h of bounded.hits)
      expect(typeof h.value.n, 'hits carry decoded values').toBe('number');

    const full = db.search('body', 'x', { limit: 1_000 });
    expect(full.length).toBe(300);
    const fullKeys = new Set(full.map((h) => h.key));
    for (const h of bounded.hits) expect(fullKeys.has(h.key)).toBeTruthy();
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- plan 10: sidecar mutation serialization + staged → persist → publish --

/** White-box handle on the private persistTextIndexDefinitions, to inject a
 *  sidecar-write failure at the exact transaction point. */
function stubTextPersist(
  db: MiniDb,
  impl: (defs: { name: string }[]) => Promise<void>,
): () => void {
  const priv = db as unknown as {
    persistTextIndexDefinitions: (defs: { name: string }[]) => Promise<void>;
  };
  const saved = priv.persistTextIndexDefinitions;
  priv.persistTextIndexDefinitions = impl;
  return () => {
    priv.persistTextIndexDefinitions = saved;
  };
}

async function textSidecarNames(dir: string): Promise<string[]> {
  try {
    return (
      JSON.parse(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8')) as {
        name: string;
      }[]
    )
      .map((d) => d.name)
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('MiniDb: concurrent createTextIndex calls are serialized; memory == sidecar == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { title: 'hello world', body: 'full text body' });
    const results = await Promise.allSettled([
      db.createTextIndex('title', { fields: ['title'] }),
      db.createTextIndex('body', { fields: ['body'] }),
      db.dropTextIndex('neverThere'),
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(await textSidecarNames(dir)).toStrictEqual(['body', 'title']);
    // Both builds (registered before building) saw the pre-existing document.
    expect(db.search('title', 'hello').map((r) => r.key)).toStrictEqual(['a']);
    expect(db.search('body', 'text').map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    expect(await textSidecarNames(dir)).toStrictEqual(['body', 'title']);
    expect(db.search('title', 'hello').map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: createTextIndex persist failure: no phantom, postings removed, original error rethrown, retry succeeds', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { text: 'hello world' });
    const boom = new Error('injected sidecar write failure');
    const restore = stubTextPersist(db, async () => {
      throw boom;
    });
    await expect(db.createTextIndex('body', { fields: ['text'] })).rejects.toBe(boom);
    restore();
    // No phantom: the index is gone from memory and from the sidecar, and its
    // derived postings file was removed (exactly like dropTextIndex would).
    expect(() => db.search('body', 'hello')).toThrow(/no such text index/);
    expect(await textSidecarNames(dir)).toStrictEqual([]);
    expect((await fs.readdir(dir)).filter((f) => f.includes('postings'))).toStrictEqual([]);
    // Retry succeeds — no phantom "already exists".
    await db.createTextIndex('body', { fields: ['text'] });
    expect(db.search('body', 'hello').map((r) => r.key)).toStrictEqual(['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: dropTextIndex persist failure: the index stays searchable and the sidecar is unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createTextIndex('body', { fields: ['text'] });
    await db.set('a', { text: 'hello world' });
    const before = await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8');
    const boom = new Error('injected sidecar write failure');
    const restore = stubTextPersist(db, async () => {
      throw boom;
    });
    await expect(db.dropTextIndex('body')).rejects.toBe(boom);
    restore();
    // The index is still live: searchable, and its postings file intact.
    expect(db.search('body', 'hello').map((r) => r.key)).toStrictEqual(['a']);
    expect(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8')).toBe(before);
    // A later successful drop persists fine.
    expect(await db.dropTextIndex('body')).toBe(true);
    expect(await textSidecarNames(dir)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: dropTextIndex persist window: a compaction postings rebuild skips the dropping index (no orphan, no leaked handle)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createTextIndex('body', { fields: ['text'] });
    // Dirty the index so it is a postings-rebuild candidate.
    await db.set('a', { text: 'hello world' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    // Park INSIDE the persist, then let the real write through: the drop
    // completes end-to-end, only delayed.
    const privPersist = db as unknown as {
      persistTextIndexDefinitions(defs: { name: string }[]): Promise<void>;
    };
    const original = privPersist.persistTextIndexDefinitions;
    const restore = stubTextPersist(db, async (defs) => {
      entered();
      await gate;
      await original.call(db, defs);
    });
    const drop = db.dropTextIndex('body');
    // The drop is parked inside its persist, the index marked staged-drop.
    await inPersist;
    const priv = db as unknown as {
      rebuildTextPostings(): Promise<void>;
      text: Map<string, TextIndex>;
    };
    const ti = priv.text.get('body')!;
    expect(ti.needsRebuild(), 'setup: the index is a rebuild candidate').toBe(true);
    // A background compaction's postings rebuild lands in the window. The
    // build (if started) sets ti.building synchronously, so this assertion is
    // not timing-dependent.
    const rebuild = priv.rebuildTextPostings();
    expect(ti.building, 'a dropping index must not start a postings build').toBe(false);
    release();
    expect(await drop).toBe(true);
    await rebuild;
    restore();
    // No late build commit: no orphan postings file re-created after the
    // drop's close+rm, and no live handle left on the dropped index.
    expect((await fs.readdir(dir)).filter((f) => f.includes('postings'))).toStrictEqual([]);
    expect((ti as unknown as { pf: unknown }).pf).toBe(null);
    expect(await textSidecarNames(dir)).toStrictEqual([]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 11: tokenizer output validated at the write boundary ------------

type TiPrivates = {
  delta: Map<string, Map<number, number>>;
  deltaCount: number;
  docLen: Map<number, number>;
  keys: (string | undefined)[];
  keyToId: Map<string, number>;
  buildQueue: unknown;
};

test('TextIndex: a throwing tokenizer leaves the live view, delta and buildQueue untouched (review #24)', () => {
  let fail = false;
  const ti = new TextIndex({
    tokenizer: (s) => {
      if (fail) throw new Error('boom');
      return tokenize(s);
    },
    // A working query tokenizer (the ngram pair pattern): searches must not
    // go through the failing index-side tokenizer.
    queryTokenizer: (s) => tokenize(s),
  });
  const priv = ti as unknown as TiPrivates;

  ti.add('k', { bio: 'hello world' });
  expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['k']);

  // Overwrite with a failing tokenizer: rejected BEFORE any mutation, so the
  // old document stays searchable instead of being tombstoned into a ghost.
  fail = true;
  expect(() => {
    ti.add('k', { bio: 'goodbye world' });
  }).toThrow(/boom/);
  expect(ti.N).toBe(1);
  expect(ti.search('hello').map((h) => h.key), 'old doc survives the failed overwrite').toStrictEqual(['k']);
  expect(ti.search('goodbye')).toStrictEqual([]);
  expect(priv.docLen.size, 'no ghost docLen entry').toBe(1);
  expect(priv.keys.length, 'no ghost docID').toBe(1);
  expect(priv.deltaCount, 'delta holds exactly the old doc’s terms').toBe(2);

  // A fresh key fails just as cleanly.
  expect(() => {
    ti.add('fresh', { bio: 'quux' });
  }).toThrow(/boom/);
  expect(ti.N).toBe(1);
  expect(priv.keyToId.has('fresh')).toBe(false);

  // Mid-build: the failed write never reaches the build queue either, so the
  // swap-time replay cannot re-throw half-way through the queue.
  fail = false;
  const b = ti.beginBuild();
  b.add('staged', { bio: 'staged doc' });
  fail = true;
  expect(() => {
    ti.add('q', { bio: 'queued?' });
  }).toThrow(/boom/);
  expect((priv.buildQueue as unknown[] | null)?.length, 'the failed add was never queued').toBe(0);
  expect(ti.search('hello').map((h) => h.key), 'live view intact during the build').toStrictEqual(['k']);
  b.abort();
  ti.close();
});

test('TextIndex: an overlong custom-tokenizer term is rejected before any mutation (review #27)', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({
      postingsPath: path.join(dir, 't.postings'),
      tokenizer: () => ['你'.repeat(30000)],
    });
    const priv = ti as unknown as TiPrivates;
    // '你'.repeat(30000) is 90000 utf8 bytes > 0xffff — it would have made
    // every postings rebuild throw RangeError, permanently poisoning the index.
    expect(() => {
      ti.add('k', { bio: 'x' });
    }).toThrow(/longer than 65535 utf8 bytes/);
    expect(ti.N).toBe(0);
    expect(priv.docLen.size).toBe(0);
    expect(priv.deltaCount).toBe(0);
    // The build path validates at the same boundary (and aborts cleanly).
    await expect(ti.build([{ key: 'k', value: { bio: 'x' } }])).rejects.toThrow(/longer than 65535 utf8 bytes/);
    ti.close();

    // A healthy index over the same postings path builds and searches fine.
    const ti2 = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti2.add('k', { bio: 'hello world' });
    await ti2.build([{ key: 'k', value: { bio: 'hello world' } }]);
    expect(ti2.search('hello').map((h) => h.key)).toStrictEqual(['k']);
    ti2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: a throwing tokenizer rejects set with zero side effects; the old doc stays searchable (review #24)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createTextIndex('ft', { fields: ['t'] });
    await db.set('k1', { t: 'hello world' });
    const ti = (
      db as unknown as { text: Map<string, { tokenizer: (s: string) => string[] }> }
    ).text.get('ft')!;
    const priv = ti as unknown as TiPrivates & { N: number };
    const origTokenizer = ti.tokenizer;
    ti.tokenizer = () => {
      throw new Error('boom');
    };

    // Insert rejected: store, delta, buildQueue, N, docLen all untouched.
    await expect(db.set('k2', { t: 'bad insert' })).rejects.toThrow(/boom/);
    expect(db.get('k2')).toBe(undefined);
    expect(db.size).toBe(1);
    // Overwrite rejected: the old document is fully intact.
    await expect(db.set('k1', { t: 'goodbye' })).rejects.toThrow(/boom/);
    expect(db.get('k1')).toStrictEqual({ t: 'hello world' });
    expect(db.search('ft', 'hello').map((h) => h.key), 'old doc still searchable').toStrictEqual(['k1']);
    expect(db.search('ft', 'goodbye')).toStrictEqual([]);
    expect(priv.N).toBe(1);
    expect(priv.docLen.size).toBe(1);
    expect(priv.deltaCount, 'delta holds exactly the old doc’s terms').toBe(2);
    expect(priv.buildQueue).toBe(null);

    // Restored tokenizer: writes flow again; reopen agrees.
    ti.tokenizer = origTokenizer;
    await db.set('k2', { t: 'fine' });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    expect(db.get('k1')).toStrictEqual({ t: 'hello world' });
    expect(db.get('k2')).toStrictEqual({ t: 'fine' });
    expect(db.search('ft', 'hello').map((h) => h.key)).toStrictEqual(['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: an overlong tokenizer term rejects set/batch; the postings rebuild stays healthy (review #27)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
    });
    await db.createTextIndex('ft', { fields: ['t'] });
    await db.set('good', { t: 'hello world' });
    const ti = (
      db as unknown as {
        text: Map<string, { tokenizer: (s: string) => string[]; customTokenizer: boolean }>;
      }
    ).text.get('ft')!;
    const origTokenizer = ti.tokenizer;
    // Simulate a custom tokenizer (the MiniDb definition only ever wires
    // default/ngram): the length validation only guards custom output.
    ti.customTokenizer = true;
    ti.tokenizer = () => ['你'.repeat(30000)];

    await expect(db.set('bad', { t: 'x' })).rejects.toThrow(/longer than 65535 utf8 bytes/);
    await expect(db.batch([{ op: 'set', key: 'bad2', value: { t: 'x' } }])).rejects.toThrow(/longer than 65535 utf8 bytes/);
    expect(db.get('bad'), 'the poisonous doc never enters the store').toBe(undefined);
    expect(db.get('bad2')).toBe(undefined);

    // Back to a healthy tokenizer: writes and the postings rebuild both work.
    ti.customTokenizer = false;
    ti.tokenizer = origTokenizer;
    await db.set('good2', { t: 'another doc' });
    await db.compact(); // rotates + rebuilds text postings from the store
    expect(db.search('ft', 'hello').map((h) => h.key)).toStrictEqual(['good']);
    expect(db.search('ft', 'another').map((h) => h.key)).toStrictEqual(['good2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 6: byte-bounded cache + async search + rebase ---------------------

test('decoded postings cache honors the byte budget, not just the term count', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath, cacheTerms: 1000, cacheBytes: 4096 });
    // 200 docs each carrying many distinct terms -> several large decoded
    // lists; a 4 KiB byte budget can only hold a handful of them.
    for (let i = 0; i < 200; i++) {
      ti.add(`k${i}`, { text: `alpha beta gamma doc${i} shared${i % 10} common` });
    }
    await ti.build(
      [...Array(200)].map((_, i) => ({
        key: `k${i}`,
        value: { text: `alpha beta gamma doc${i} shared${i % 10} common` },
      })),
    );
    // Warm the cache with several hot lists (each has 200 entries ~ 4.8 KiB
    // by the cache's own accounting).
    ti.search('alpha');
    ti.search('beta');
    ti.search('gamma');
    ti.search('common');
    const cacheSize = (ti as unknown as { cache: Map<string, unknown> }).cache.size;
    expect(cacheSize < 4, `byte budget evicted big lists (cache holds ${cacheSize})`).toBeTruthy();
    // Results stay correct after eviction.
    expect(ti.search('alpha', { limit: 300 }).length).toBe(200);
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('searchBoundedAsync matches searchBounded on a disk-backed index', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build(
      [...Array(500)].map((_, i) => ({
        key: `k${i}`,
        value: { text: `hello world doc ${i} 异步 ${i % 11}` },
      })),
    );
    for (const q of ['hello', '异步', 'hello world', 'missing-term']) {
      expect(await ti.searchBoundedAsync(q, { limit: 25 }), q).toStrictEqual(ti.searchBounded(q, { limit: 25 }));
    }
    // With a visit budget too (capped decodes must match as well).
    expect(await ti.searchBoundedAsync('hello', { maxVisits: 10 })).toStrictEqual(ti.searchBounded('hello', { maxVisits: 10 }));
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('commitRebase swaps in an externally built base and replays the capture', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build([
      { key: 'a', value: { text: 'alpha one' } },
      { key: 'b', value: { text: 'beta two' } },
    ]);
    expect(ti.search('alpha').length).toBe(1);

    // Stage a "worker-produced" base by hand: a fresh postings file with a
    // different doc set, then commit it through the rebase machinery while
    // mutations land during the capture window.
    const workerPostings = path.join(dir, 'w.postings');
    const agg = new Map<string, Map<number, number>>([
      ['gamma', new Map([[0, 1]])],
      ['three', new Map([[0, 1]])],
    ]);
    const { PostingsFile: PF } = await import('../src/text-postings.js');
    const built = await PF.rebuild(
      workerPostings,
      [...agg].map(([term, entries]) => ({ term, entries })),
    );
    ti.beginRebase();
    // Mutations landing AFTER the capture started: must be replayed onto the
    // new base at commit (they already applied to the live view too).
    ti.add('d', { text: 'delta four' });
    ti.remove('a');
    const containers = await TextIndex.prepareRebaseContainers(
      [...built.dict],
      ['c'],
      new Map([[0, 2]]),
    );
    ti.commitRebase({
      postingsPath: workerPostings,
      containers,
      liveCount: 1,
      postingsFileInfo: { bytes: built.bytes, crc32: built.crc32 },
    });
    // New base visible; old base gone; captured ops replayed.
    expect(ti.search('gamma').map((h) => h.key)).toStrictEqual(['c']);
    expect(ti.search('alpha').length).toBe(0);
    expect(ti.search('delta').map((h) => h.key)).toStrictEqual(['d']);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('abortRebase discards the capture and keeps the previous base', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build([{ key: 'a', value: { text: 'alpha one' } }]);
    ti.beginRebase();
    ti.add('b', { text: 'beta two' });
    ti.abortRebase();
    expect(ti.rebasing).toBe(false);
    expect(ti.search('alpha').length).toBe(1);
    expect(ti.search('beta').length).toBe(1);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('commitRebase adopts a disk base over a memory-base index (read-only scratch shape)', async () => {
  const dir = await tmpDir();
  try {
    // A memory-base index (the read-only-open shape) adopts the worker-built
    // disk base from a caller-owned location instead of throwing — the same
    // flip a generation attach makes.
    const ti = new TextIndex({});
    expect(ti.memBase !== null).toBeTruthy();
    ti.add('old', { text: 'stale one' });

    const workerPostings = path.join(dir, 'w.postings');
    const agg = new Map<string, Map<number, number>>([['gamma', new Map([[0, 1]])]]);
    const built = await PostingsFile.rebuild(
      workerPostings,
      [...agg].map(([term, entries]) => ({ term, entries })),
    );
    // The deferred open-time build arms the capture and marks the base
    // unavailable until the commit lands.
    ti.basePending = true;
    ti.beginRebase();
    expect(() => ti.search('gamma')).toThrow(/still building/);
    ti.add('new', { text: 'delta two' });
    const containers = await TextIndex.prepareRebaseContainers(
      [...built.dict],
      ['c'],
      new Map([[0, 1]]),
    );
    ti.commitRebase({
      postingsPath: workerPostings,
      containers,
      liveCount: 1,
      postingsFileInfo: { bytes: built.bytes, crc32: built.crc32 },
    });
    expect(ti.memBase).toBe(null); // flipped to the adopted disk base
    expect(ti.basePending).toBe(false);
    expect(ti.currentPostingsPath).toBe(workerPostings);
    // The old memory base is gone; the captured write replayed onto the new one.
    expect(ti.search('gamma').map((h) => h.key)).toStrictEqual(['c']);
    expect(ti.search('stale').length).toBe(0);
    expect(ti.search('delta').map((h) => h.key)).toStrictEqual(['new']);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('an async base read straddling a base commit re-reads the fresh base instead of caching the stale one', async () => {
  const dir = await tmpDir();
  try {
    const p1 = path.join(dir, 'a.postings');
    const ti = new TextIndex({ postingsPath: p1 });
    await ti.build([{ key: 'a', value: { text: 'alpha' } }]);
    // Count terms instead of searching here — a search would warm the
    // decoded-postings cache and the straddle below would never reach the file.
    expect(ti.termCount()).toBe(1);

    // Park the async postings read on a gate; a base commit lands meanwhile.
    const realPf = ti.pf!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ti.pf = {
      path: realPf.path,
      read: (entry: never, max?: number) => realPf.read(entry, max),
      readAsync: async (entry: never, max?: number) => {
        await gate;
        return realPf.read(entry, max);
      },
      close: () => realPf.close(),
    } as unknown as PostingsFile;

    const readP = ti.searchBoundedAsync('alpha');
    // Let the read reach the parked gate before committing the new base.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const b = ti.beginBuild({ postingsPath: path.join(dir, 'b.postings') });
    b.add('b', { text: 'beta' }); // the new base has no 'alpha' at all
    await b.commit();
    release();

    const res = await readP;
    // The straddled read must NOT serve the stale base's hit, and the cache
    // must not be poisoned either: the next query sees only the fresh base.
    expect(res.hits).toStrictEqual([]);
    expect(ti.searchBounded('alpha').hits).toStrictEqual([]);
    expect(ti.searchBounded('beta').hits.length).toBe(1);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
});

test('TextIndexBuildingError while the base is pending (sync + async + query)', async () => {
  const ti = new TextIndex({ name: 'guarded' });
  ti.add('k', { text: 'hello world' });
  // Pending base: every search entry raises the typed signal instead of
  // silently serving the delta alone.
  ti.basePending = true;
  let buildingError: unknown;
  try {
    ti.search('hello');
  } catch (error) {
    buildingError = error;
  }
  expect((buildingError as Error | undefined)?.name).toBe('TextIndexBuildingError');
  expect(() => ti.searchBounded('hello')).toThrow(/still building/);
  await expect(ti.searchBoundedAsync('hello')).rejects.toThrow(/still building/);
  // A base build with a LIVE old base underneath does NOT set the flag:
  // staged builds keep serving (beginBuild alone must not trip the guard).
  ti.basePending = false;
  const b = ti.beginBuild();
  expect(ti.search('hello').length).toBe(1);
  b.abort();
  expect(ti.search('hello').length).toBe(1);
});

test('a base read with no open handle raises TextIndexBuildingError instead of serving delta-only', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ name: 'guarded', postingsPath });
    await ti.build([{ key: 'a', value: { text: 'hello alpha' } }]);
    // The Windows beforeRename close (retried for up to ~2.5 s) and a failed
    // reopen both leave the dictionary describing a file no handle reads —
    // that is a momentarily unreadable base, NOT an empty one: reading it as
    // empty silently drops the base's hits.
    ti.pf!.close();
    ti.pf = null;
    expect(() => ti.search('hello')).toThrow(TextIndexBuildingError);
    expect(() => ti.searchBounded('hello')).toThrow(/still building/);
    await expect(ti.searchBoundedAsync('hello')).rejects.toThrow(/still building/);

    // A disk index whose FIRST build has not committed yet is genuinely
    // baseless (createTextIndex relies on it): it keeps serving its delta.
    const fresh = new TextIndex({ postingsPath: path.join(dir, 'q.postings') });
    fresh.add('k', { text: 'hello world' });
    expect(fresh.search('hello').map((h) => h.key)).toStrictEqual(['k']);

    // The handle comes back: the base is served whole again.
    ti.pf = PostingsFile.open(postingsPath);
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);
    ti.close();
    fresh.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PostingsFile: a replace that cannot land (EPERM) throws instead of renaming aside', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'x.postings');
  try {
    await PostingsFile.rebuild(p, [{ term: 'hello', entries: [[0, 1]] }]);
    const before = await fs.readFile(p);
    // The real EPERM window spans ~2.5 s of retries; the injected seam is the
    // same call the retry would ultimately make, and it fails ONLY on the
    // fixed name — so a fallback that renames aside would succeed and return.
    await expect(PostingsFile.rebuild(p, [{ term: 'bye', entries: [[0, 1]] }], {
        rename: epermOn(p),
      })).rejects.toThrow(/EPERM/);
    // The previous file is byte-identical and no renamed-aside copy exists:
    // the fixed name is the only one the generation manifest records and the
    // loader verifies, so a second name would be a guaranteed ENOENT there.
    expect(await fs.readFile(p)).toStrictEqual(before);
    expect((await fs.readdir(dir)).toSorted()).toStrictEqual(['x.postings', 'x.postings.tmp']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: a failed postings replace keeps the previous base and the retry lands', async () => {
  const dir = await tmpDir();
  const orig = PostingsFile.rebuild;
  const eperm = (): NodeJS.ErrnoException => {
    const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
    e.code = 'EPERM';
    return e;
  };
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 'p.postings') });
    await ti.build([{ key: 'a', value: { text: 'hello alpha' } }]);
    // Phase 1: every replace fails.
    PostingsFile.rebuild = () => Promise.reject(eperm());

    await expect(ti.build([{ key: 'b', value: { text: 'beta hello' } }])).rejects.toThrow(/EPERM/);
    // The commit never happened, so the previous base is still served whole
    // (and the staged keys never leaked into the live view).
    expect(ti.search('hello').map((h) => h.key)).toStrictEqual(['a']);
    expect(ti.search('beta').length).toBe(0);

    // Phase 2: the retry is a normal rebuild and lands.
    PostingsFile.rebuild = orig;
    await ti.build([
      { key: 'a', value: { text: 'hello alpha' } },
      { key: 'b', value: { text: 'beta hello' } },
    ]);
    expect(ti.search('hello', { limit: 10 }).map((h) => h.key)).toStrictEqual(['a', 'b']);
    ti.close();
  } finally {
    PostingsFile.rebuild = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a postings rebuild reclaims renamed-aside files from the retired EPERM fallback', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'x.postings');
  try {
    await PostingsFile.rebuild(p, [{ term: 'hello', entries: [[0, 1]] }]);
    // One leftover per failed replace: `<file>.<pid36><ts36>`.
    await fs.writeFile(`${p}.3k5x1ymfc8k2x9`, 'stale');
    // Neither a shorter non-pid/ts suffix nor another index's leftovers are
    // this rebuild's business.
    await fs.writeFile(`${p}.rebuild`, 'not ours');
    await fs.writeFile(path.join(dir, 'other.postings.3k5x1ymfc8k2x9'), 'other stem');

    await PostingsFile.rebuild(p, [{ term: 'hello', entries: [[0, 2]] }]);
    expect((await fs.readdir(dir)).toSorted()).toStrictEqual([
      'other.postings.3k5x1ymfc8k2x9',
      'x.postings',
      'x.postings.rebuild',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
