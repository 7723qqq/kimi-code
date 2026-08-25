import { describe, expect, it, vi } from 'vitest';

import { parseBingSearchResults } from '#/app/auth/webSearch/engines/bing/parser';
import { parseDuckDuckGoResults } from '#/app/auth/webSearch/engines/duckduckgo/parser';
import {
  LocalWebSearchProvider,
  resolveResultLimit,
  resolveSearchEngines,
} from '#/app/auth/webSearch/providers/local-web-search';

describe('local web search engines', () => {
  it('parses DuckDuckGo HTML results and decodes the redirector', () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example Page</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">A snippet about example.</a>
        <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">example.com</a>
      </div>
    </body></html>`;
    const results = parseDuckDuckGoResults(html, 10);
    expect(results).toEqual([
      {
        title: 'Example Page',
        url: 'https://example.com/page',
        description: 'A snippet about example.',
        source: 'example.com',
        engine: 'duckduckgo',
      },
    ]);
  });

  it('returns empty for a DuckDuckGo challenge page', () => {
    expect(parseDuckDuckGoResults('<html><body>anomaly detected</body></html>', 10)).toEqual([]);
  });

  it('parses Bing results and decodes the /ck/a redirector', () => {
    const html = `<html><body><ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://cn.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl">Bing Result</a></h2>
        <div class="b_caption"><p>Bing snippet text.</p></div>
      </li>
    </ol></body></html>`;
    const results = parseBingSearchResults(html, 10);
    expect(results[0]).toMatchObject({
      title: 'Bing Result',
      url: 'https://example.com/page',
      description: 'Bing snippet text.',
    });
  });

  it('resolves the engine order from KIMI_CODE_SEARCH_ENGINE with a bing default', () => {
    expect(resolveSearchEngines({})[0]).toBe('bing');
    expect(resolveSearchEngines({ KIMI_CODE_SEARCH_ENGINE: 'duckduckgo' })[0]).toBe('duckduckgo');
    expect(resolveSearchEngines({ KIMI_CODE_SEARCH_ENGINE: 'unknown' })[0]).toBe('bing');
  });

  it('honors the allowlist and caps the result limit', () => {
    const engines = resolveSearchEngines({
      KIMI_CODE_SEARCH_ENGINE: 'sogou',
      KIMI_CODE_ALLOWED_SEARCH_ENGINES: 'sogou,baidu',
    });
    expect(engines).toEqual(['sogou', 'baidu']);
    expect(resolveResultLimit({})).toBe(10);
    expect(resolveResultLimit({ KIMI_CODE_SEARCH_RESULTS: '5' })).toBe(5);
    expect(resolveResultLimit({ KIMI_CODE_SEARCH_RESULTS: '99' })).toBe(10);
  });
});

describe('LocalWebSearchProvider abort propagation', () => {
  const multiEngineEnv = {
    KIMI_CODE_SEARCH_ENGINE: 'duckduckgo',
    KIMI_CODE_ALLOWED_SEARCH_ENGINES: 'duckduckgo,baidu',
  };

  it('rethrows immediately when the caller aborts, without trying remaining engines', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error('aborted mid-search');
    });
    const provider = new LocalWebSearchProvider({ env: multiEngineEnv, fetchImpl });

    await expect(provider.search('query', { signal: controller.signal })).rejects.toThrow(
      'aborted mid-search',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rethrows an engine AbortError instead of falling through to other engines', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn(async () => {
      throw abortError;
    });
    const provider = new LocalWebSearchProvider({ env: multiEngineEnv, fetchImpl });

    await expect(provider.search('query')).rejects.toThrow('The operation was aborted.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still reports aggregate engine failures for non-abort errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const provider = new LocalWebSearchProvider({ env: multiEngineEnv, fetchImpl });

    await expect(provider.search('query')).rejects.toThrow(/All search engines failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
