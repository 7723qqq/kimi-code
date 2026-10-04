import { describe, expect, it } from 'vitest';

import { createWsSubscriptionLru } from '../src/lib/wsSubscriptionLru';

function setup(max: number) {
  const unsubscribed: string[] = [];
  const evicted: string[] = [];
  let active: string | null = null;
  const lru = createWsSubscriptionLru({
    max,
    isActive: (id) => id === active,
    unsubscribe: (id) => unsubscribed.push(id),
    onEvict: (id) => evicted.push(id),
  });
  return {
    lru,
    unsubscribed,
    evicted,
    setActive(id: string | null) {
      active = id;
    },
  };
}

describe('createWsSubscriptionLru', () => {
  it('keeps the most recently retained sessions within the cap', () => {
    const { lru, unsubscribed, evicted, setActive } = setup(2);
    lru.retain('a');
    lru.retain('b');
    lru.retain('c');
    expect(unsubscribed).toEqual(['a']);
    expect(evicted).toEqual(['a']);
    lru.retain('d');
    expect(unsubscribed).toEqual(['a', 'b']);
  });

  it('re-retaining moves a session back to the newest slot', () => {
    const { lru, unsubscribed } = setup(2);
    lru.retain('a');
    lru.retain('b');
    lru.retain('a');
    lru.retain('c');
    // 'a' was re-retained, so 'b' is the oldest and gets evicted.
    expect(unsubscribed).toEqual(['b']);
  });

  it('never evicts the active session even when it sits at the tail', () => {
    const { lru, unsubscribed, evicted, setActive } = setup(2);
    lru.retain('a');
    lru.retain('b');
    lru.retain('c');
    expect(unsubscribed).toEqual(['a']);
    // Make the tail ('b') active: eviction must skip it and take 'c' instead.
    setActive('b');
    lru.retain('d');
    expect(unsubscribed).toEqual(['a', 'c']);
    expect(evicted).toEqual(['a', 'c']);
  });

  it('evicts the newest non-active entry when the tail is active', () => {
    const { lru, unsubscribed, setActive } = setup(1);
    lru.retain('a');
    setActive('a');
    lru.retain('b');
    // The cap stays effective: 'a' (active) is skipped, so 'b' — the only
    // non-active candidate — is evicted instead.
    expect(unsubscribed).toEqual(['b']);
  });

  it('drop removes a session from eviction consideration', () => {
    const { lru, unsubscribed } = setup(2);
    lru.retain('a');
    lru.retain('b');
    lru.drop('a');
    lru.retain('c');
    // 'a' was dropped, so the cap only sees 'b' and 'c' — nothing evicted.
    expect(unsubscribed).toEqual([]);
  });
});