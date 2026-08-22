import type { WebSearchResult } from '#/agent/tools/web-search/web-search';

import { searchBing } from '../bing';
import { searchBrave } from '../brave';
import { searchDuckDuckGo } from '../duckduckgo';
import type { SearchEngineOptions } from '../types';

const DEFAULT_DELEGATE_ENGINE: 'bing' | 'duckduckgo' | 'brave' = 'bing';

function isLinuxDoHostname(hostname: string): boolean {
  return hostname === 'linux.do' || hostname.endsWith('.linux.do');
}

export async function searchLinuxDo(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const siteQuery = `site:linux.do ${query}`;
  let results: WebSearchResult[] = [];
  if (DEFAULT_DELEGATE_ENGINE === 'duckduckgo') {
    results = await searchDuckDuckGo(siteQuery, limit, options);
  } else if (DEFAULT_DELEGATE_ENGINE === 'bing') {
    results = await searchBing(siteQuery, limit, options);
  } else {
    results = await searchBrave(siteQuery, limit, options);
  }
  if (results.length === 0 && DEFAULT_DELEGATE_ENGINE !== 'brave') {
    results = await searchBrave(siteQuery, limit, options);
  }
  const filtered = results.filter((result) => {
    try {
      return isLinuxDoHostname(new URL(result.url).hostname);
    } catch {
      return false;
    }
  });
  return filtered.slice(0, limit).map((result) => ({ ...result, siteName: 'linux.do' }));
}
