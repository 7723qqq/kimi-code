
// test/store.test.ts
import { expect, test } from 'bun:test';

import { Store } from '../src/store.js';

const B = (s) => Buffer.from(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('basic set/get/del/has/size', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('a', B('1'));
  s.set('b', B('2'));
  expect(s.get('a').toString()).toBe('1');
  expect(s.size).toBe(2);
  expect(s.has('a')).toBeTruthy();
  expect(s.del('a')).toBeTruthy();
  expect(!s.has('a')).toBeTruthy();
  expect(s.size).toBe(1);
});

test('keys are binary-safe (Buffer keys, arbitrary bytes)', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  const k = Buffer.from([0x00, 0xff, 0x10, 0x00]);
  s.set(k, B('bin'));
  expect(s.get(Buffer.from([0x00, 0xff, 0x10, 0x00])).toString()).toBe('bin');
  expect(s.size).toBe(1);
});

test('overwrite updates value without growing size', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('x', B('1'));
  s.set('x', B('2'));
  expect(s.size).toBe(1);
  expect(s.get('x').toString()).toBe('2');
});

test('lazy expiration on get', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('soon', B('gone'), Date.now() - 1); // already expired
  expect(s.get('soon')).toBe(undefined);
  expect(s.size).toBe(0);
});

test('active expiration sweep removes due keys', async () => {
  const s = new Store({ activeExpireIntervalMs: 10, activeExpireMaxPerTick: 100 });
  s.set('e1', B('v'), Date.now() + 20);
  s.set('e2', B('v'), Date.now() + 20);
  s.set('keep', B('v')); // no ttl
  expect(s.map.size).toBe(3);
  await sleep(80); // several sweep ticks
  expect(s.map.size).toBe(1);
  expect(s.get('keep').toString()).toBe('v');
  s.close();
});

test('overwriting a TTL key clears the old expiration (stale heap entry skipped)', async () => {
  const s = new Store({ activeExpireIntervalMs: 10, activeExpireMaxPerTick: 100 });
  s.set('k', B('tmp'), Date.now() + 20); // expires soon
  s.set('k', B('persist')); // overwritten with NO ttl
  await sleep(80);
  expect(s.get('k').toString()).toBe('persist');
  s.close();
});

test('entries() yields only live entries', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('a', B('1'));
  s.set('b', B('2'), Date.now() - 1); // expired
  const rows = [...s.entries()];
  expect(rows.length).toBe(1);
  expect(rows[0].key.toString()).toBe('a');
});

test('ordered scan over keys (range)', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['c', 'a', 'd', 'b'].forEach((k) => s.set(k, B(k)));
  expect([...s.scan({ gte: 'b', lte: 'd' })].map((r) => r.key.toString())).toStrictEqual(['b', 'c', 'd']);
});

test('prefix scan over keys', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['user:1', 'user:2', 'user:10', 'order:1'].forEach((k) => s.set(k, B(k)));
  expect([...s.prefix('user:')].map((r) => r.key.toString())).toStrictEqual(['user:1', 'user:10', 'user:2']);
});

test('stores dt per record and exposes via getRecord', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('k', B('v'), 0, { dt1: 1000, dt2: 2000 });
  const r = s.getRecord('k');
  expect(r.dt).toStrictEqual({ dt1: 1000, dt2: 2000 });
  expect([...s.entries()][0].dt.dt1).toBe(1000);
});

test('delete removes key from the ordered index', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['a', 'b', 'c'].forEach((k) => s.set(k, B(k)));
  s.del('b');
  expect([...s.scan()].map((r) => r.key.toString())).toStrictEqual(['a', 'c']);
});

test('has() does not materialize disk-backed values', () => {
  let reads = 0;
  const s = new Store({
    activeExpireIntervalMs: 0,
    readValue: () => {
      reads++;
      return B('disk-value');
    },
  });
  s.setRef('dk', { kind: 'disk', loc: { file: 'snapshot', off: 0, len: 10 } });
  expect(reads).toBe(0);
  expect(s.has('dk')).toBe(true);
  expect(s.has('missing')).toBe(false);
  expect(reads).toBe(0); // has() must stay metadata-only (no positioned read)
  expect(s.get('dk').toString()).toBe('disk-value');
  expect(reads).toBe(1);
  s.close();
});

test('rawKeys yields ordered keys without materializing values', () => {
  let reads = 0;
  const s = new Store({
    activeExpireIntervalMs: 0,
    readValue: () => {
      reads++;
      return B('v');
    },
  });
  s.setRef('a', { kind: 'disk', loc: { file: 'snapshot', off: 0, len: 1 } });
  s.set('b', B('2'));
  s.setRef('c', { kind: 'disk', loc: { file: 'snapshot', off: 2, len: 1 } });
  s.set('d', B('4'), Date.now() - 1); // already expired
  expect([...s.rawKeys({})]).toStrictEqual(['a', 'b', 'c']);
  expect([...s.rawKeys({ gte: 'b' })]).toStrictEqual(['b', 'c']);
  expect(reads).toBe(0);
  s.close();
});

test('size stays correct with and without TTL keys in play', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  for (let i = 0; i < 5; i++) s.set(`k${i}`, B('v'));
  expect(s.size).toBe(5); // O(1) path (no TTL keys)
  s.set('t', B('v'), Date.now() + 10_000);
  expect(s.size).toBe(6); // TTL key in play -> live-count path
  s.set('t', B('v2')); // overwrite without TTL
  expect(s.size).toBe(6);
  expect(s.del('t')).toBeTruthy();
  expect(s.size).toBe(5); // back to the fast path
  s.set('u', B('v'), Date.now() - 1); // already expired at set
  expect(s.size).toBe(5); // expired keys are not counted
  s.close();
});

test('active expiration drains a simultaneous-expiry storm within seconds', async () => {
  // default-class settings: 100/count quota per tick + a small time budget for bursts
  const s = new Store({ activeExpireIntervalMs: 100, activeExpireMaxPerTick: 100 });
  const N = 3000;
  for (let i = 0; i < N; i++) s.set(`t${i}`, B('v'), Date.now() + 30);
  expect(s.map.size).toBe(N);
  await sleep(1200);
  // the old fixed ~1000/s rate would have left ~1500+ dead entries behind
  expect(s.map.size).toBe(0);
  s.close();
});

test('reapExpiredDue drains only due entries via the TTL heap', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('expired', B('1'), Date.now() - 1000);
  s.set('future', B('2'), Date.now() + 3_600_000);
  s.set('plain', B('3'));
  expect(s.reapExpiredDue(), 'only the due record is reaped').toBe(1);
  expect(!s.has('expired')).toBeTruthy();
  expect(s.has('future')).toBeTruthy();
  expect(s.has('plain')).toBeTruthy();
  // nothing due -> a no-op (and no full-store sweep needed)
  expect(s.reapExpiredDue()).toBe(0);
  expect(s.map.size).toBe(2);
  s.close();
});

test('reapExpiredDue skips stale heap entries from overwritten TTLs', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  const t1 = Date.now() - 1000; // already past
  s.set('k', B('1'), t1);
  s.set('k', B('2'), Date.now() + 3_600_000); // overwrite: the t1 heap entry is now stale
  expect(s.reapExpiredDue(), 'the stale entry must not reap the live record').toBe(0);
  expect(s.get('k')?.toString()).toBe('2');
  s.close();
});

test('reapExpiredDue falls back to a full scan when the heap diverged from the map', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('a', B('1'), Date.now() - 1000);
  s.set('b', B('2'), Date.now() - 1000);
  // Force the broken invariant (live TTL records, empty heap) the fallback
  // guards against; no code path may produce this.
  (s as unknown as { heap: { clear(): void } }).heap.clear();
  expect(s.reapExpiredDue(), 'divergence detected -> full resync reap').toBe(2);
  expect(s.map.size).toBe(0);
  s.close();
});

test('bulkLoadRefsAsync pauses active expiry: a TTL expiring mid-load cannot diverge the ordered index', async () => {
  // A TTL that elapses DURING the sliced load: with the active-expire tick
  // firing mid-load, the reaped key would vanish from the map but stay in
  // the rebuilt ordered index — and a later re-set would insert a SECOND
  // ordered entry, producing duplicate scan results. Pausing expiry for the
  // load keeps the resulting state identical to the sync bulk load.
  const short = 'a-short-ttl'; // sorts before every kNNNNN
  const records = [
    {
      kstr: short,
      ref: { kind: 'memory' as const, value: B('v0') },
      expireAt: Date.now() + 1,
      dt: null,
    },
    ...Array.from({ length: 20000 }, (_, i) => ({
      kstr: `k${String(i).padStart(5, '0')}`,
      ref: { kind: 'memory' as const, value: B(`v${i}`) },
      expireAt: 0,
      dt: null,
    })),
  ];
  const s = new Store({ activeExpireIntervalMs: 1 }); // a tick lands within the first yields
  try {
    await s.bulkLoadRefsAsync(records, { sliceEvery: 50 }); // 400 yields: the tick fires mid-load
    // The divergence repro: re-set the key — a stale ordered entry left by a
    // mid-load reap would now show it twice in ordered scans.
    s.set(short, B('v1'));
    const scanned = [...s.scan()].map((e) => e.key.toString());
    expect(scanned.length, 'ordered scan must not contain duplicates').toBe(new Set(scanned).size);
    expect(scanned.length).toBe(20001);
    // The ordered index and the map agree exactly (no stale, no missing).
    expect([...s.rawKeys()]).toStrictEqual([...s.map.keys()].toSorted());
    // And the next tick after the load reaps normally (expiry only deferred).
    s.set(short, B('v2'), Date.now() - 1); // already expired
    await sleep(20);
    expect(s.map.has(short)).toBe(false);
    expect([...s.rawKeys()]).toStrictEqual([...s.map.keys()].toSorted());
  } finally {
    s.close();
  }
});
