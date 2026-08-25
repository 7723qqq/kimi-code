import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { debugLog, engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';

const JUEJIN_SEARCH_URL = 'https://api.juejin.cn/search_api/v1/search';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  pragma: 'no-cache',
  priority: 'u=1, i',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'content-type': 'application/json',
  Accept: '*/*',
  Host: 'api.juejin.cn',
  Connection: 'keep-alive',
};

interface JuejinSearchItem {
  result_model?: {
    article_id?: string;
    article_info?: { digg_count?: number; view_count?: number };
    author_user_info?: { user_name?: string };
    category?: { category_name?: string };
    tags?: Array<{ tag_name?: string }>;
  };
  title_highlight?: string;
  content_highlight?: string;
}

interface JuejinSearchResponse {
  err_no?: number;
  err_msg?: string;
  has_more?: boolean;
  cursor?: string;
  data?: JuejinSearchItem[];
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchSearchPage(
  query: string,
  cursor: string,
  limit: number,
  options: SearchEngineOptions,
): Promise<string> {
  const searchUrl = new URL(JUEJIN_SEARCH_URL);
  searchUrl.searchParams.set('aid', '2608');
  searchUrl.searchParams.set('uuid', '7259393293459605051');
  searchUrl.searchParams.set('spider', '0');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('id_type', '0');
  searchUrl.searchParams.set('cursor', cursor);
  searchUrl.searchParams.set('limit', String(limit));
  searchUrl.searchParams.set('search_type', '0');
  searchUrl.searchParams.set('sort_type', '0');
  searchUrl.searchParams.set('version', '1');
  let response;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(searchUrl.toString(), {
        headers: FALLBACK_HEADERS,
        signal: options.signal,
      });
      response = {
        ok: native.ok,
        status: native.status,
        statusText: native.statusText,
        text: () => native.text(),
        header: (name: string) => native.headers.get(name),
      };
    } else {
      if (options.signal?.aborted === true) {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      response = await engineFetch(searchUrl.toString(), {
        headers: FALLBACK_HEADERS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Juejin search request to ${searchUrl.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Juejin search request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

function parseJuejinResults(data: JuejinSearchItem[] | undefined): WebSearchResult[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  for (const item of data) {
    const resultModel = item.result_model;
    if (resultModel === undefined || resultModel.article_id === undefined) {
      continue;
    }
    const cleanTitle = (item.title_highlight ?? '').replaceAll(/<\/?em>/g, '');
    const cleanContent = (item.content_highlight ?? '').replaceAll(/<\/?em>/g, '');
    const tagNames = (resultModel.tags ?? [])
      .map((tag) => tag.tag_name ?? '')
      .filter(Boolean)
      .join(', ');
    const categoryName = resultModel.category?.category_name ?? '';
    const diggCount = resultModel.article_info?.digg_count ?? 0;
    const viewCount = resultModel.article_info?.view_count ?? 0;
    const description = `${cleanContent} | 分类: ${categoryName} | 标签: ${tagNames} | 👍 ${diggCount} | 👀 ${viewCount}`;
    results.push({
      title: cleanTitle || 'No title',
      url: `https://juejin.cn/post/${resultModel.article_id}`,
      snippet: description,
      siteName: resultModel.author_user_info?.user_name ?? undefined,
    });
  }
  return results;
}

export async function searchJuejin(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: WebSearchResult[] = [];
  let cursor = '0';
  while (allResults.length < limit) {
    const pageLimit = Math.min(20, limit - allResults.length);
    const body = await fetchSearchPage(query, cursor, pageLimit, options);
    let parsed: JuejinSearchResponse;
    try {
      parsed = JSON.parse(body) as JuejinSearchResponse;
    } catch (error) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Juejin search request returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (parsed.err_no !== 0) {
      debugLog(`Juejin API error: ${parsed.err_msg ?? 'unknown'}`);
      break;
    }
    if (!Array.isArray(parsed.data)) {
      break;
    }
    const results = parseJuejinResults(parsed.data);
    allResults.push(...results);
    if (
      !parsed.has_more ||
      parsed.cursor === undefined ||
      parsed.cursor === '' ||
      results.length === 0
    ) {
      break;
    }
    cursor = parsed.cursor;
  }
  return allResults.slice(0, limit);
}
