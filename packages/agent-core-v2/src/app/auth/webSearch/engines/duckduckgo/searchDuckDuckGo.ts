/**
 * `auth` domain (cross-cutting) — DuckDuckGo search engine, ported from the
 * open-websearch project (`engines/duckduckgo/searchDuckDuckGo.js`).
 * Request-mode scraping only: tries the preloaded `links.duckduckgo.com/d.js`
 * JSONP endpoint first (paginated through the `s` offset), falling back to
 * the html.duckduckgo.com form endpoint, both through `engineFetch` (or the
 * injected `fetchImpl` in tests). The original playwright fallback is not
 * ported. HTTP failures throw `Error2` (`WEB_FETCH_FAILED`); pages that
 * yield no parseable results return an empty list.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch, type EngineHttpResponse } from '../engine-http';
import type { SearchEngineOptions } from '../types';
import {
  extractDuckDuckGoPreloadUrl,
  parseDuckDuckGoJsonp,
  parseDuckDuckGoResults,
  type DuckDuckGoSearchResult,
} from './parser';

const REQUEST_TIMEOUT_MS = 30_000;

// Client-hint (`sec-ch-ua*`) and navigation-metadata (`sec-fetch-*`) headers
// make DuckDuckGo answer with an anomaly page; a plain browser UA, Accept
// and referer are enough.
const PRELOAD_PAGE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  referer: 'https://duckduckgo.com/',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const PRELOAD_DATA_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
  referer: 'https://duckduckgo.com/',
};

const HTML_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Apifox/1.0.0 (https://apifox.com)',
  Accept: '*/*',
  Host: 'html.duckduckgo.com',
  Connection: 'keep-alive',
};

const HTML_RESULT_URL = 'https://html.duckduckgo.com/html/';

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function fetchDuckDuckGoText(
  url: string,
  options: SearchEngineOptions,
  init: { headers?: Record<string, string>; body?: string },
): Promise<string> {
  const method = init.body !== undefined ? 'POST' : 'GET';
  let response: EngineHttpResponse;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(url, {
        method,
        headers: init.headers,
        body: init.body,
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
      response = await engineFetch(url, {
        method,
        headers: init.headers,
        body: init.body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `DuckDuckGo request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `DuckDuckGo request failed: HTTP ${String(response.status)}.`, {
      details: { status: response.status },
    });
  }
  return  response.text();
}

async function searchDuckDuckGoPreloadUrl(
  query: string,
  maxResults: number,
  options: SearchEngineOptions,
): Promise<DuckDuckGoSearchResult[]> {
  const allResults: DuckDuckGoSearchResult[] = [];
  const searchUrl = new URL('https://duckduckgo.com/?t=h_&ia=web');
  // `URLSearchParams` serializes spaces as `+`; DuckDuckGo answers a
  // `%20`-encoded query with a 202 anomaly page.
  searchUrl.searchParams.set('q', query);
  const pageHtml = await fetchDuckDuckGoText(searchUrl.toString(), options, { headers: PRELOAD_PAGE_HEADERS });
  const basePreloadUrl = extractDuckDuckGoPreloadUrl(pageHtml);
  if (basePreloadUrl === '') {
    return allResults;
  }
  const preloadUrlObj = new URL(basePreloadUrl);
  let offset = 0;
  while (allResults.length < maxResults) {
    preloadUrlObj.searchParams.set('s', String(offset));
    const jsonpText = await fetchDuckDuckGoText(preloadUrlObj.toString(), options, { headers: PRELOAD_DATA_HEADERS });
    const pageResults = parseDuckDuckGoJsonp(jsonpText);
    if (pageResults.length === 0) {
      break;
    }
    offset += pageResults.length;
    for (const result of pageResults) {
      if (allResults.length >= maxResults) {
        break;
      }
      allResults.push(result);
    }
  }
  return allResults.slice(0, maxResults);
}

async function searchDuckDuckGoHtml(
  query: string,
  maxResults: number,
  options: SearchEngineOptions,
): Promise<DuckDuckGoSearchResult[]> {
  const allResults: DuckDuckGoSearchResult[] = [];
  let offset = 0;
  const firstBody = new URLSearchParams({ q: query }).toString();
  const firstHtml = await fetchDuckDuckGoText(HTML_RESULT_URL, options, { headers: HTML_HEADERS, body: firstBody });
  let pageResults = parseDuckDuckGoResults(firstHtml, maxResults);
  allResults.push(...pageResults);
  while (allResults.length < maxResults && pageResults.length > 0) {
    offset += pageResults.length;
    const body = new URLSearchParams({
      q: query,
      s: String(offset),
      dc: String(offset),
      v: 'l',
      o: 'json',
      api: 'd.js',
    }).toString();
    const html = await fetchDuckDuckGoText(HTML_RESULT_URL, options, { headers: HTML_HEADERS, body });
    pageResults = parseDuckDuckGoResults(html, maxResults - allResults.length);
    allResults.push(...pageResults);
  }
  return allResults.slice(0, maxResults);
}

function toWebSearchResult(result: DuckDuckGoSearchResult): WebSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  };
}

/**
 * Search DuckDuckGo and return up to `limit` results.
 *
 * The preloaded `d.js` path is tried first; when it yields nothing (or fails
 * at the HTTP layer) the html.duckduckgo.com form endpoint is used instead.
 */
export async function searchDuckDuckGo(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  try {
    const results = await searchDuckDuckGoPreloadUrl(query, limit, options);
    if (results.length > 0) {
      return results.map(toWebSearchResult);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  const results = await searchDuckDuckGoHtml(query, limit, options);
  return results.map(toWebSearchResult);
}
