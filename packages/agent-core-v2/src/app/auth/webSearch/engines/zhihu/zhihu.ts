/**
 * `auth` domain (cross-cutting) — Zhihu search engine, ported from the
 * open-websearch project (`engines/zhihu/zhihu.js`). Request-mode only:
 * searches the `site:zhuanlan.zhihu.com` scoped query through the configured
 * delegate engine (Bing / DuckDuckGo, defaulting to Bing like the original
 * `config.defaultSearchEngine`), filters results to the
 * `zhuanlan.zhihu.com` hostname, and forces the `zhuanlan.zhihu.com` site
 * name. The original has no playwright path, so nothing is skipped.
 * Delegate failures throw `Error2` (`WEB_FETCH_FAILED`); no matching
 * results return `[]`.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';

import { searchBing } from '../bing';
import { searchDuckDuckGo } from '../duckduckgo';
import type { SearchEngineOptions } from '../types';

/** Matches open-websearch's `config.defaultSearchEngine` default. */
const DEFAULT_DELEGATE_ENGINE: string = 'bing';

const ZHIHU_COLUMN_HOSTNAME = 'zhuanlan.zhihu.com';

export async function searchZhihu(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const siteQuery = `site:zhuanlan.zhihu.com ${query}`;
  const results =
    DEFAULT_DELEGATE_ENGINE === 'duckduckgo'
      ? await searchDuckDuckGo(siteQuery, limit, options)
      : await searchBing(siteQuery, limit, options);
  const filtered = results.filter((result) => {
    try {
      return new URL(result.url).hostname === ZHIHU_COLUMN_HOSTNAME;
    } catch {
      return false;
    }
  });
  return filtered.slice(0, limit).map((result) => ({ ...result, siteName: ZHIHU_COLUMN_HOSTNAME }));
}
