/**
 * `auth` domain (cross-cutting) — Exa search engine, ported from the
 * open-websearch project (`engines/exa/exa.js`). Request-mode only: POSTs a
 * JSON query to the `exa.ai/search/api/search-fast` endpoint through
 * `engineFetch` (or the injected `fetchImpl` in tests) and maps the returned
 * `results` array. The original implementation reads no API key and has no
 * playwright path, so nothing is skipped. HTTP/network failures throw
 * `Error2` (`WEB_FETCH_FAILED`); an API response without results returns
 * `[]`.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';

const EXA_SEARCH_URL = 'https://exa.ai/search/api/search-fast';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'Connection': 'keep-alive',
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
  'content-type': 'text/plain;charset=UTF-8',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'origin': 'https://exa.ai',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

interface ExaApiItem {
  title?: string;
  url?: string;
  author?: string;
  publishedDate?: string;
}

interface ExaApiResponse {
  results?: ExaApiItem[];
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export async function searchExa(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const data = {
    numResults: limit,
    query,
    type: 'auto',
    useAutoprompt: true,
    domainFilterType: 'include',
    text: true,
    density: 'compact',
    resolvedSearchType: 'neural',
    moderation: true,
    fastMode: false,
    rerankerType: 'default',
  };
  let response;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(EXA_SEARCH_URL, {
        method: 'POST',
        headers: FALLBACK_HEADERS,
        body: JSON.stringify(data),
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
      response = await engineFetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: FALLBACK_HEADERS,
        body: JSON.stringify(data),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Exa request to ${EXA_SEARCH_URL} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Exa request failed: HTTP ${String(response.status)}.`, {
      details: { status: response.status },
    });
  }
  let apiResponse: ExaApiResponse;
  try {
    apiResponse = JSON.parse(await response.text()) as ExaApiResponse;
  } catch (error) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Exa request returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const apiResults = apiResponse.results;
  if (!Array.isArray(apiResults) || apiResults.length === 0) {
    return [];
  }
  return apiResults.slice(0, limit).flatMap((item) => {
    if (item.url === undefined) {
      return [];
    }
    let hostname: string;
    try {
      hostname = new URL(item.url).hostname;
    } catch {
      return [];
    }
    return [
      {
        title: item.title ?? 'No title',
        url: item.url,
        snippet: `Author: ${item.author ?? 'N/A'}. Published: ${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}`,
        siteName: hostname,
      },
    ];
  });
}
