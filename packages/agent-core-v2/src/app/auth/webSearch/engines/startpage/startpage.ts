/**
 * `auth` domain (cross-cutting) — Startpage search engine, ported from the
 * open-websearch project (`engines/startpage/startpage.js`). Request-mode
 * scraping only (the original has no playwright path): caches the `sc`
 * search token fetched from the Startpage homepage, posts form-encoded
 * queries to `/sp/search` through `engineFetch` (or the injected
 * `fetchImpl` in tests), replays the interstitial follow-up POST when
 * detected, and paginates until `limit` results are collected.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch, type EngineHttpResponse } from '../engine-http';
import type { SearchEngineOptions } from '../types';
import {
  extractInterstitialPayload,
  extractResultsFromHtml,
  extractScCode,
  isCaptchaPage,
  type StartpageSearchResult,
} from './parser';

const STARTPAGE_BASE_URL = 'https://www.startpage.com';
const STARTPAGE_SEARCH_URL = `${STARTPAGE_BASE_URL}/sp/search`;
const STARTPAGE_SC_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_REQUEST_TIMEOUT_MS = 20_000;

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

let cachedScCode: string | undefined;
let cachedScAt = 0;

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchStartpageText(
  url: string,
  options: SearchEngineOptions,
  init: {
    method?: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<string> {
  let response: EngineHttpResponse;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
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
    } else {
      if (options.signal?.aborted === true) {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      response = await engineFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        timeoutMs: init.timeoutMs,
      });
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Startpage request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Startpage request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function getScCode(options: SearchEngineOptions): Promise<string> {
  const now = Date.now();
  if (cachedScCode !== undefined && now - cachedScAt < STARTPAGE_SC_TTL_MS) {
    return cachedScCode;
  }
  const html = await fetchStartpageText(`${STARTPAGE_BASE_URL}/`, options, {
    headers: {
      ...COMMON_HEADERS,
      Accept: ACCEPT_HEADER,
    },
    timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
  });
  if (isCaptchaPage(html)) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      'Startpage returned a verification or anti-bot page while requesting the search token',
    );
  }
  const scCode = extractScCode(html);
  if (scCode === undefined) {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'Failed to extract Startpage search token');
  }
  cachedScCode = scCode;
  cachedScAt = now;
  return scCode;
}

async function searchStartpagePage(
  query: string,
  page: number,
  options: SearchEngineOptions,
): Promise<StartpageSearchResult[]> {
  const scCode = await getScCode(options);
  const formData = new URLSearchParams({
    query,
    cat: 'web',
    t: 'device',
    sc: scCode,
    abp: '1',
    abd: '1',
    abe: '1',
  });
  if (page > 1) {
    formData.set('page', String(page));
    formData.set('segment', 'startpage.udog');
  }
  const searchHeaders: Record<string, string> = {
    ...COMMON_HEADERS,
    Accept: ACCEPT_HEADER,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: STARTPAGE_BASE_URL,
    Referer: `${STARTPAGE_BASE_URL}/`,
  };
  let html = await fetchStartpageText(STARTPAGE_SEARCH_URL, options, {
    method: 'POST',
    headers: searchHeaders,
    body: formData.toString(),
    timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
  });
  const interstitialPayload = extractInterstitialPayload(html);
  if (interstitialPayload !== undefined) {
    const followUpHtml = await fetchStartpageText(STARTPAGE_SEARCH_URL, options, {
      method: 'POST',
      headers: {
        ...searchHeaders,
        Referer: STARTPAGE_SEARCH_URL,
      },
      body: new URLSearchParams(interstitialPayload).toString(),
      timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
    });
    html = followUpHtml;
  }
  return extractResultsFromHtml(html);
}

export async function searchStartpage(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: StartpageSearchResult[] = [];
  const seenUrls = new Set<string>();
  const maxPage = Math.max(1, Math.ceil(limit / DEFAULT_PAGE_SIZE));
  for (let page = 1; page <= maxPage && allResults.length < limit; page += 1) {
    const pageResults = await searchStartpagePage(query, page, options);
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
  return allResults.slice(0, limit).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  }));
}
