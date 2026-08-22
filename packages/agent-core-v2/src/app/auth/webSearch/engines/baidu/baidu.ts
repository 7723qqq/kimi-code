import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';
import { parseBaiduSearchResults, type BaiduSearchResult } from './parser';

const BAIDU_BASE_URL = 'https://www.baidu.com/s';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

function buildBaiduSearchUrl(query: string, pageNumber: number): string {
  const url = new URL(BAIDU_BASE_URL);
  url.searchParams.set('wd', query);
  url.searchParams.set('pn', String(pageNumber * 10));
  url.searchParams.set('ie', 'utf-8');
  url.searchParams.set('mod', '1');
  url.searchParams.set('isbd', '1');
  url.searchParams.set('isid', 'f7ba1776007bcf9e');
  url.searchParams.set('oq', query);
  url.searchParams.set('tn', '88093251_62_hao_pg');
  url.searchParams.set('usm', '1');
  url.searchParams.set('fenlei', '256');
  url.searchParams.set('rsv_idx', '1');
  url.searchParams.set('rsv_pq', 'f7ba1776007bcf9e');
  url.searchParams.set(
    'rsv_t',
    '8179fxGiNMUh/0dXHrLsJXPlKYbkj9S5QH6rOLHY6pG6OGQ81YqzRTIGjjeMwEfiYQTSiTQIhCJj',
  );
  url.searchParams.set('bs', query);
  url.searchParams.set('_ss', '1');
  url.searchParams.set('f4s', '1');
  url.searchParams.set('csor', '5');
  url.searchParams.set('_cr1', '30385');
  return url.toString();
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchSearchPage(url: string, options: SearchEngineOptions): Promise<string> {
  if (options.fetchImpl !== undefined) {
    const response = await options.fetchImpl(url, {
      headers: FALLBACK_HEADERS,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Baidu search request failed: HTTP ${String(response.status)}.`,
        {
          details: { status: response.status },
        },
      );
    }
    return response.text();
  }
  if (options.signal?.aborted === true) {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    throw abortError;
  }
  const response = await engineFetch(url, {
    headers: FALLBACK_HEADERS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Baidu search request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

function toWebSearchResult(result: BaiduSearchResult): WebSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  };
}

export async function searchBaidu(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: BaiduSearchResult[] = [];
  let pageNumber = 0;
  while (allResults.length < limit) {
    let html: string;
    try {
      html = await fetchSearchPage(buildBaiduSearchUrl(query, pageNumber), options);
    } catch (error) {
      if (error instanceof Error2 || isAbortError(error)) {
        throw error;
      }
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Baidu search request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const results = parseBaiduSearchResults(html);
    allResults.push(...results);
    if (results.length === 0) {
      break;
    }
    pageNumber += 1;
  }
  return allResults.slice(0, limit).map(toWebSearchResult);
}
