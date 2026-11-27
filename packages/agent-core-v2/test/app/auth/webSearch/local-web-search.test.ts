import { describe, expect, it, mock } from 'bun:test';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { parseBingSearchResults } from '#/app/auth/webSearch/engines/bing/parser';
import { parseDuckDuckGoResults } from '#/app/auth/webSearch/engines/duckduckgo/parser';
import {
  searchArxiv,
  searchCrossref,
  searchGithub,
  searchNpm,
  searchOpenAlex,
  searchPypi,
  searchSemanticScholar,
  searchWikipedia,
} from '#/app/auth/webSearch/engines/verticals';
import {
  applyQueryModifiers,
  fuseSearchResults,
  matchesDomainFilter,
  normalizeResultUrl,
  titleSimilarity,
} from '#/app/auth/webSearch/providers/fusion';
import {
  LocalWebSearchProvider,
  resolveResultLimit,
  resolveSearchConcurrency,
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

  it('honors the allowlist, concurrency config, and caps the result limit', () => {
    const engines = resolveSearchEngines({
      KIMI_CODE_SEARCH_ENGINE: 'sogou',
      KIMI_CODE_ALLOWED_SEARCH_ENGINES: 'sogou,baidu',
    });
    expect(engines).toEqual(['sogou', 'baidu']);
    expect(resolveResultLimit({})).toBe(10);
    expect(resolveResultLimit({ KIMI_CODE_SEARCH_RESULTS: '5' })).toBe(5);
    expect(resolveResultLimit({ KIMI_CODE_SEARCH_RESULTS: '99' })).toBe(10);
    expect(resolveSearchConcurrency({})).toBe(5);
    expect(resolveSearchConcurrency({ KIMI_CODE_SEARCH_CONCURRENT: '0' })).toBe(1);
    expect(resolveSearchConcurrency({ KIMI_CODE_SEARCH_CONCURRENCY: '8' })).toBe(8);
  });
});

describe('LocalWebSearchProvider abort propagation', () => {
  const multiEngineEnv = {
    KIMI_CODE_SEARCH_ENGINE: 'duckduckgo',
    KIMI_CODE_ALLOWED_SEARCH_ENGINES: 'duckduckgo,baidu',
    KIMI_CODE_SEARCH_CONCURRENT: '0',
  };

  it('rethrows immediately when the caller aborts, without trying remaining engines', async () => {
    const controller = new AbortController();
    const fetchImpl = mock(async () => {
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
    const fetchImpl = mock(async () => {
      throw abortError;
    });
    const provider = new LocalWebSearchProvider({ env: multiEngineEnv, fetchImpl });

    await expect(provider.search('query')).rejects.toThrow('The operation was aborted.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still reports aggregate engine failures for non-abort errors', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('rate limited');
    });
    const provider = new LocalWebSearchProvider({ env: multiEngineEnv, fetchImpl });

    await expect(provider.search('query')).rejects.toThrow(/All search engines failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('propagates caller abort in concurrent fan-out mode', async () => {
    const controller = new AbortController();
    const fetchImpl = mock<FetchLike>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }) as Promise<Response>,
    );
    const provider = new LocalWebSearchProvider({
      env: {
        KIMI_CODE_ALLOWED_SEARCH_ENGINES: 'github,npm',
        KIMI_CODE_SEARCH_CONCURRENCY: '2',
      },
      fetchImpl,
    });
    const pending = provider.search('bun', { scope: 'package', signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('RRF fusion and dedup', () => {
  it('normalizes URLs by removing tracking params, hashes, and trailing slashes', () => {
    expect(normalizeResultUrl('https://WWW.Example.com:443/docs/guide/?utm_source=x&b=2&a=1#sec')).toBe(
      'example.com/docs/guide?a=1&b=2',
    );
    expect(normalizeResultUrl('http://example.com:80/docs/guide?fbclid=abc')).toBe(
      'example.com/docs/guide',
    );
  });

  it('detects near-duplicate titles across English and CJK strings', () => {
    expect(titleSimilarity('TypeScript 5.8 Release Notes', 'TypeScript 5.8 Release Notes!')).toBeGreaterThan(
      0.85,
    );
    expect(titleSimilarity('深入理解 Bun SQLite 全文检索', '深入理解 Bun SQLite 全文检索指南')).toBeGreaterThan(
      0.7,
    );
  });

  it('fuses multiple engines using RRF, dedups duplicates, and filters domains', () => {
    const fused = fuseSearchResults(
      [
        {
          engine: 'bing',
          results: [
            { title: 'Alpha Guide', url: 'https://bun.sh/docs/alpha?utm_source=bing', snippet: 'Short' },
            { title: 'Beta', url: 'https://other.example/beta', snippet: 'Noise' },
          ],
        },
        {
          engine: 'duckduckgo',
          results: [
            { title: 'Other Bun Doc', url: 'https://bun.sh/docs/other', snippet: 'Good' },
            {
              title: 'Alpha Guide Official',
              url: 'http://www.bun.sh/docs/alpha/',
              snippet: 'Much longer informative snippet about Alpha',
              date: '2026-05-01',
            },
          ],
        },
      ],
      { limit: 5, domains: ['bun.sh'] },
    );

    expect(fused.map((r) => r.url)).toEqual([
      'https://bun.sh/docs/alpha?utm_source=bing',
      'https://bun.sh/docs/other',
    ]);
    expect(fused[0]?.engines).toEqual(['bing', 'duckduckgo']);
    expect(fused[0]?.snippet).toBe('Much longer informative snippet about Alpha');
    expect(fused[0]?.date).toBe('2026-05-01');
    expect(matchesDomainFilter('https://docs.bun.sh/api', ['bun.sh'])).toBe(true);
    expect(matchesDomainFilter('https://evil-bun.sh/', ['bun.sh'])).toBe(false);
    expect(applyQueryModifiers('sqlite fts5', { domains: ['bun.sh', 'sqlite.org'] })).toBe(
      'sqlite fts5 (site:bun.sh OR site:sqlite.org)',
    );
  });
});

describe('vertical search engines', () => {
  it('parses arXiv Atom XML feeds', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed>
        <entry>
          <id>http://arxiv.org/abs/2501.00001v1</id>
          <published>2025-01-15T12:00:00Z</published>
          <title>Attention &amp; Retrieval Study</title>
          <summary>An empirical study on fused retrieval.</summary>
        </entry>
      </feed>`;
    const fetchImpl = mock<FetchLike>().mockResolvedValue(new Response(xml, { status: 200 }));
    const results = await searchArxiv('retrieval', 5, { fetchImpl });
    expect(results).toEqual([
      {
        title: 'Attention & Retrieval Study',
        url: 'http://arxiv.org/abs/2501.00001v1',
        snippet: 'An empirical study on fused retrieval.',
        siteName: 'arXiv',
        date: '2025-01-15',
      },
    ]);
  });

  it('parses OpenAlex, Semantic Scholar, Crossref, GitHub, Wikipedia, npm, and PyPI payloads', async () => {
    const fetchImpl = mock<FetchLike>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.openalex.org')) {
        return Response.json({
          results: [
            {
              display_name: 'OpenAlex Paper',
              publication_date: '2025-03-10',
              cited_by_count: 42,
              abstract_inverted_index: { Fast: [0], search: [1], engine: [2] },
              primary_location: {
                landing_page_url: 'https://papers.test/oa',
                source: { display_name: 'NeurIPS' },
              },
            },
          ],
        });
      }
      if (url.includes('api.semanticscholar.org')) {
        return Response.json({
          data: [
            {
              title: 'S2 Paper',
              url: 'https://papers.test/s2',
              abstract: 'S2 abstract',
              publicationDate: '2025-02-01',
              citationCount: 7,
              venue: 'ICLR',
            },
          ],
        });
      }
      if (url.includes('api.crossref.org')) {
        return Response.json({
          message: {
            items: [
              {
                title: ['Crossref Work'],
                DOI: '10.1000/test',
                abstract: '<jats:p>Clean text</jats:p>',
                'container-title': ['ACM'],
                issued: { 'date-parts': [[2024, 11, 5]] },
              },
            ],
          },
        });
      }
      if (url.includes('api.github.com')) {
        return Response.json({
          items: [
            {
              full_name: 'oven-sh/bun',
              html_url: 'https://github.com/oven-sh/bun',
              description: 'Fast JS runtime',
              stargazers_count: 75000,
              language: 'Zig',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
        });
      }
      if (url.includes('wikipedia.org')) {
        return Response.json({
          query: {
            search: [
              {
                title: 'BM25',
                snippet: '<span class="searchmatch">BM25</span> ranking function',
                timestamp: '2026-01-02T00:00:00Z',
              },
            ],
          },
        });
      }
      if (url.includes('registry.npmjs.org')) {
        return Response.json({
          objects: [
            {
              package: {
                name: 'zod',
                version: '4.3.6',
                description: 'Schema validation',
                date: '2026-01-03T00:00:00Z',
                links: { npm: 'https://www.npmjs.com/package/zod' },
              },
            },
          ],
        });
      }
      if (url.includes('pypi.org/pypi/')) {
        return Response.json({
          info: {
            name: 'httpx',
            version: '0.28.0',
            summary: 'Next-gen HTTP client',
            project_url: 'https://pypi.org/project/httpx/',
          },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const [oa, s2, cr, gh, wiki, npmRes, pypiRes] = await Promise.all([
      searchOpenAlex('test', 2, { fetchImpl }),
      searchSemanticScholar('test', 2, { fetchImpl }),
      searchCrossref('test', 2, { fetchImpl }),
      searchGithub('bun', 2, { fetchImpl }),
      searchWikipedia('BM25', 2, { fetchImpl }),
      searchNpm('zod', 2, { fetchImpl }),
      searchPypi('httpx', 2, { fetchImpl }),
    ]);

    expect(oa[0]).toMatchObject({
      title: 'OpenAlex Paper',
      snippet: 'Cited by 42. Fast search engine',
      siteName: 'NeurIPS',
    });
    expect(s2[0]).toMatchObject({ title: 'S2 Paper', siteName: 'ICLR' });
    expect(cr[0]).toMatchObject({
      title: 'Crossref Work',
      url: 'https://doi.org/10.1000/test',
      snippet: 'Clean text',
      date: '2024-11-05',
    });
    expect(gh[0]).toMatchObject({
      title: 'oven-sh/bun',
      snippet: '[★ 75000 | Zig] Fast JS runtime',
    });
    expect(wiki[0]).toMatchObject({
      title: 'BM25',
      url: 'https://en.wikipedia.org/wiki/BM25',
      snippet: 'BM25 ranking function',
    });
    expect(npmRes[0]).toMatchObject({ title: 'zod', snippet: 'v4.3.6: Schema validation' });
    expect(pypiRes[0]).toMatchObject({
      title: 'httpx',
      url: 'https://pypi.org/project/httpx/',
    });

    const academicProvider = new LocalWebSearchProvider({ fetchImpl, concurrency: 4 });
    const academic = await academicProvider.search('retrieval', { scope: 'academic', limit: 5 });
    expect(academic.length).toBeGreaterThanOrEqual(3);
    expect(academic.some((item) => item.siteName === 'NeurIPS')).toBe(true);
    expect(academic.some((item) => item.siteName === 'ICLR')).toBe(true);
  });

  it('cuts off slower hanging engines once fast quorum engines satisfy the limit', async () => {
    let abortedSlowCount = 0;
    const fetchImpl = mock<FetchLike>().mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.openalex.org')) {
        return Promise.resolve(
          Response.json({
            results: [
              { display_name: 'Dense Passage Retrieval', primary_location: { landing_page_url: 'https://papers.test/1' } },
              { display_name: 'Sparse Lexical Indexing', primary_location: { landing_page_url: 'https://papers.test/2' } },
            ],
          }),
        );
      }
      if (url.includes('api.crossref.org')) {
        return Promise.resolve(
          Response.json({
            message: {
              items: [
                { title: ['Hybrid Vector Search'], URL: 'https://papers.test/3' },
              ],
            },
          }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          abortedSlowCount += 1;
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const provider = new LocalWebSearchProvider({
      fetchImpl,
      concurrency: 4,
      engineTimeoutMs: 12_000,
    });
    const startedAt = Date.now();
    const results = await provider.search('retrieval', { scope: 'academic', limit: 3 });
    const elapsedMs = Date.now() - startedAt;

    expect(results.map((r) => r.url)).toEqual([
      'https://papers.test/1',
      'https://papers.test/3',
      'https://papers.test/2',
    ]);
    expect(abortedSlowCount).toBeGreaterThanOrEqual(1);
    expect(elapsedMs).toBeLessThan(3_000);
  });
});

