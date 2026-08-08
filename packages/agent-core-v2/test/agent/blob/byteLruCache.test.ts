/**
 * Scenario: the byte-bounded LRU cache used by the agent blob service.
 *
 * Responsibilities asserted: hit returns the stored value, miss is undefined,
 * least-recently-used eviction on overflow, recency refresh on get, oversize
 * payloads are never cached, replacement re-accounts size, multiple entries
 * evict to make room, `has` checks membership without touching LRU, `delete`
 * removes entries and re-accounts bytes, and `size`/`bytes` report correctly.
 * Pure data-structure tests — no DI, no IO.
 *
 * Run: `pnpm test -- test/blob/byteLruCache.test.ts`
 */

import { describe, expect, it } from 'vitest';

import { ByteLruCache } from '#/agent/blob/byteLruCache';

const buf = (n: number): Buffer => Buffer.alloc(n);

describe('ByteLruCache', () => {
  it('returns the stored buffer on a hit', () => {
    const cache = new ByteLruCache(16);
    cache.set('a', Buffer.from('hello'));

    expect(cache.get('a')?.equals(Buffer.from('hello'))).toBe(true);
  });

  it('returns undefined for a missing key', () => {
    const cache = new ByteLruCache(16);

    expect(cache.get('nope')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    cache.set('c', buf(5));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('refreshes recency on get so a read entry survives eviction', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    cache.get('a');
    cache.set('c', buf(5));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('does not cache a payload larger than maxBytes and keeps existing entries', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));

    cache.set('big', buf(11));

    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('re-accounts size when an existing key is replaced', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(4));
    cache.set('a', buf(9));

    cache.set('b', buf(2));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('evicts multiple entries to make room for a larger payload', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(3));
    cache.set('b', buf(3));
    cache.set('c', buf(3));

    cache.set('d', buf(5));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('has() checks membership without refreshing LRU position', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    // 'has' should not refresh 'a' — 'a' should still be evicted next.
    expect(cache.has('a')).toBe(true);
    cache.set('c', buf(5));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('has() returns false for a missing key', () => {
    const cache = new ByteLruCache(16);
    expect(cache.has('nope')).toBe(false);
  });

  it('delete() removes an entry and re-accounts bytes', () => {
    const cache = new ByteLruCache(10);
    cache.set('a', buf(5));
    cache.set('b', buf(5));

    expect(cache.delete('a')).toBe(true);
    expect(cache.bytes).toBe(5);
    expect(cache.size).toBe(1);

    // The freed space should allow a new entry without evicting 'b'.
    cache.set('c', buf(5));
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('delete() returns false for a missing key', () => {
    const cache = new ByteLruCache(16);
    expect(cache.delete('nope')).toBe(false);
  });

  it('size and bytes report current cache state', () => {
    const cache = new ByteLruCache(100);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);

    cache.set('a', buf(10));
    cache.set('b', buf(20));
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(30);

    // Replacement re-accounts.
    cache.set('a', buf(15));
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(35);
  });
});
