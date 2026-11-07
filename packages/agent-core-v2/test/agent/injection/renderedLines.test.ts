import { describe, expect, it } from 'bun:test';

import {
  alreadyRendered,
  lineFingerprint,
  markRendered,
  resetRendered,
} from '#/agent/injection/renderedLines';

describe('rendered line registry', () => {
  it('treats the same experience as already rendered regardless of case and spacing', () => {
    resetRendered();
    markRendered('s1', ['  the cache ttl is 30 seconds ']);
    expect(alreadyRendered('s1', 'THE CACHE TTL IS 30 SECONDS')).toBe(true);
    expect(alreadyRendered('s1', 'the billing invoice proration rounds down')).toBe(false);
  });

  it('keeps two sessions from suppressing each other', () => {
    resetRendered();
    markRendered('session-a', ['the cache ttl is 30 seconds']);
    expect(alreadyRendered('session-a', 'the cache ttl is 30 seconds')).toBe(true);
    expect(alreadyRendered('session-b', 'the cache ttl is 30 seconds')).toBe(false);
  });

  it('keeps distinct lines separate', () => {
    resetRendered();
    markRendered('s1', ['alpha line', 'beta line']);
    expect(alreadyRendered('s1', 'alpha line')).toBe(true);
    expect(alreadyRendered('s1', 'beta line')).toBe(true);
    expect(lineFingerprint('alpha line')).not.toBe(lineFingerprint('beta line'));
  });

  it('stays bounded when many lines are rendered', () => {
    resetRendered();
    for (let index = 0; index < 2_000; index += 1) markRendered('s1', [`line ${index}`]);
    expect(alreadyRendered('s1', 'line 1999')).toBe(true);
    expect(alreadyRendered('s1', 'line 0')).toBe(false);
  });
});
