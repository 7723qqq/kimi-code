import { describe, expect, it } from 'vitest';

import { createFailoverWebSearchProvider } from '#/app/auth/webSearch/webSearchService';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';

function provider(
  results: string[],
  impl?: (query: string) => Promise<never> | void,
): WebSearchProvider {
  return {
    async search(query) {
      if (impl) await impl(query);
      return results.map((title) => ({ title, url: `https://x/${title}`, snippet: '' }));
    },
  };
}

const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

describe('createFailoverWebSearchProvider', () => {
  it('falls through to the next provider when the primary throws an auth failure', async () => {
    const primary = provider([], () => {
      throw new Error('No token for "kimi-code". Run /login to authenticate.');
    });
    const fallback = provider(['hit']);
    const p = createFailoverWebSearchProvider([primary, fallback]);
    const r = await p.search('q');
    expect(r.map((x) => x.title)).toEqual(['hit']);
  });

  it('cascades when a candidate returns an empty result set', async () => {
    const empty = provider([]);
    const next = provider(['found']);
    const p = createFailoverWebSearchProvider([empty, next]);
    const r = await p.search('q');
    expect(r.map((x) => x.title)).toEqual(['found']);
  });

  it('returns an empty result set when every candidate comes back empty without errors', async () => {
    const p = createFailoverWebSearchProvider([provider([]), provider([])]);
    expect(await p.search('q')).toEqual([]);
  });

  it('still surfaces the error when a candidate fails even though another was merely empty', async () => {
    const empty = provider([]);
    const boom = provider([], () => {
      throw new Error('boom');
    });
    const p = createFailoverWebSearchProvider([empty, boom]);
    await expect(p.search('q')).rejects.toThrow('boom');
  });

  it('surfaces the last error when every candidate fails', async () => {
    const boom = provider([], () => {
      throw new Error('network down');
    });
    const p = createFailoverWebSearchProvider([boom, boom]);
    await expect(p.search('q')).rejects.toThrow('network down');
  });

  it('rethrows caller aborts immediately without trying remaining providers', async () => {
    let secondCalled = false;
    const controller = new AbortController();
    const slow = provider([], () => {
      controller.abort();
      return Promise.reject(abortError);
    });
    const second = {
      async search() {
        secondCalled = true;
        return [];
      },
    };
    const p = createFailoverWebSearchProvider([slow, second]);
    await expect(p.search('q', { signal: controller.signal })).rejects.toBe(abortError);
    expect(secondCalled).toBe(false);
  });

  it('returns the single candidate as-is behaviorally', async () => {
    const only = provider(['solo']);
    const p = createFailoverWebSearchProvider([only]);
    const r = await p.search('q');
    expect(r.map((x) => x.title)).toEqual(['solo']);
  });
});
