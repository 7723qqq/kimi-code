/**
 * `auth` domain (cross-cutting) — Sogou search engine, ported from the
 * open-websearch project (`engines/sogou/sogou.js`). Request-mode scraping
 * only: paginates `www.sogou.com/web` HTML through `engineFetch` (or the
 * injected `fetchImpl` in tests), following redirects manually with cookie
 * accumulation, detecting anti-bot challenge pages, and parsing results
 * with `parseSogouSearchResults`. The original playwright path is not
 * ported.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch, type EngineHttpResponse } from '../engine-http';
import type { SearchEngineOptions } from '../types';
import { isSogouChallengePage, parseSogouSearchResults, type SogouSearchResult } from './parser';

const SOGOU_SEARCH_URL = 'https://www.sogou.com/web';
const SOGOU_PAGE_SIZE = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.sogou.com/',
};

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function isAllowedSogouRedirectUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (hostname === 'sogou.com' || hostname.endsWith('.sogou.com'))
  );
}

function mergeSetCookie(cookieHeader: string, setCookie: string | string[] | undefined): string {
  if (!setCookie) {
    return cookieHeader;
  }
  const cookieMap = new Map<string, string>();
  for (const cookie of cookieHeader.split(';')) {
    const trimmed = cookie.trim();
    if (!trimmed) {
      continue;
    }
    const [name] = trimmed.split('=', 1);
    if (name === undefined) {
      continue;
    }
    cookieMap.set(name, trimmed);
  }
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (!pair) {
      continue;
    }
    const [name] = pair.split('=', 1);
    if (name === undefined) {
      continue;
    }
    cookieMap.set(name, pair);
  }
  return Array.from(cookieMap.values()).join('; ');
}

async function fetchSogouHtml(initialUrl: string, options: SearchEngineOptions): Promise<string> {
  if (options.fetchImpl !== undefined) {
    let response: EngineHttpResponse;
    try {
      const native = await options.fetchImpl(initialUrl, {
        headers: COMMON_HEADERS,
        signal: options.signal,
      });
      response = {
        ok: native.ok,
        status: native.status,
        statusText: native.statusText,
        text: () => native.text(),
        stream: () => native.body,
        header: (name: string) => native.headers.get(name),
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Sogou request to ${initialUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Sogou search request failed: HTTP ${String(response.status)}.`, {
        details: { status: response.status },
      });
    }
    return  response.text();
  }

  let currentUrl = initialUrl;
  let cookieHeader = '';
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (options.signal?.aborted === true) {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      throw abortError;
    }
    let response: EngineHttpResponse;
    try {
      response = await engineFetch(currentUrl, {
        headers: {
          ...COMMON_HEADERS,
          ...(cookieHeader !== '' ? { Cookie: cookieHeader } : {}),
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        manualRedirect: true,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Sogou request to ${currentUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    cookieHeader = mergeSetCookie(cookieHeader, response.header('set-cookie') ?? undefined);
    if (response.status >= 300 && response.status < 400) {
      const location = response.header('location');
      if (!location) {
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          `Sogou returned redirect status ${String(response.status)} without a Location header`,
        );
      }
      const redirectUrl = new URL(location, currentUrl);
      if (!isAllowedSogouRedirectUrl(redirectUrl)) {
        throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Sogou redirected to an unexpected host: ${redirectUrl.hostname}`);
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (!response.ok) {
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Sogou search request failed: HTTP ${String(response.status)}.`, {
        details: { status: response.status },
      });
    }
    return  response.text();
  }
  throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'Sogou returned too many redirects');
}

async function searchSogouPage(
  query: string,
  page: number,
  options: SearchEngineOptions,
): Promise<SogouSearchResult[]> {
  const url = new URL(SOGOU_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('ie', 'utf8');
  const html = await fetchSogouHtml(url.toString(), options);
  if (isSogouChallengePage(html)) {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'Sogou returned a verification or anti-bot page');
  }
  return parseSogouSearchResults(html);
}

function toWebSearchResult(result: SogouSearchResult): WebSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  };
}

export async function searchSogou(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: SogouSearchResult[] = [];
  const seenUrls = new Set<string>();
  const maxPage = Math.max(1, Math.ceil(limit / SOGOU_PAGE_SIZE));
  for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
    const pageResults = await searchSogouPage(query, page, options);
    for (const result of pageResults) {
      if (seenUrls.has(result.url)) {
        continue;
      }
      seenUrls.add(result.url);
      allResults.push(result);
    }
    if (pageResults.length === 0) {
      break;
    }
  }
  return allResults.slice(0, limit).map(toWebSearchResult);
}
