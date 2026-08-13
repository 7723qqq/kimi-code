import { describe, expect, it } from 'vitest';

import {
  parseBingResults,
  parseDuckDuckGoResults,
  resolveSearchEngine,
} from '#/app/auth/webSearch/providers/local-web-search';

describe('local web search parsers', () => {
  it('parses DuckDuckGo HTML results and decodes the redirector', () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example Page</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">A snippet about example.</a>
      </div>
    </body></html>`;
    const results = parseDuckDuckGoResults(html);
    expect(results).toEqual([
      {
        title: 'Example Page',
        url: 'https://example.com/page',
        snippet: 'A snippet about example.',
      },
    ]);
  });

  it('returns empty for a DuckDuckGo challenge page', () => {
    expect(parseDuckDuckGoResults('<html><body>anomaly detected</body></html>')).toEqual([]);
  });

  it('parses Bing results and decodes the /ck/a redirector', () => {
    const html = `<html><body><ol id="b_results">
      <li class="b_algo">
        <h2><a href="/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl">Bing Result</a></h2>
        <div class="b_caption"><p>Bing snippet text.</p></div>
      </li>
    </ol></body></html>`;
    const results = parseBingResults(html);
    expect(results).toEqual([
      {
        title: 'Bing Result',
        url: 'https://example.com/page',
        snippet: 'Bing snippet text.',
      },
    ]);
  });

  it('resolves the engine from KIMI_CODE_SEARCH_ENGINE with a duckduckgo default', () => {
    expect(resolveSearchEngine({})).toBe('duckduckgo');
    expect(resolveSearchEngine({ KIMI_CODE_SEARCH_ENGINE: 'bing' })).toBe('bing');
    expect(resolveSearchEngine({ KIMI_CODE_SEARCH_ENGINE: 'unknown' })).toBe('duckduckgo');
  });
});
