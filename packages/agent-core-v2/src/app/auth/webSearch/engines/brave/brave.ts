import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { loadHtml, type EngineElement } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';

const BRAVE_BASE_URL = 'https://search.brave.com/search';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  Connection: 'keep-alive',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  referer: 'https://duckduckgo.com/',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

function directChildAnchor(element: EngineElement): EngineElement | null {
  const children = (
    element as EngineElement & { children?: ArrayLike<EngineElement & { tagName?: string }> }
  ).children;
  if (children === undefined) {
    return null;
  }
  for (const child of Array.from(children)) {
    if ((child.tagName ?? '').toUpperCase() === 'A') {
      return child;
    }
  }
  return null;
}

function parseBraveResults(html: string): Array<{
  title: string;
  url: string;
  description: string;
  source: string;
}> {
  const $ = loadHtml(html);
  const results: Array<{ title: string; url: string; description: string; source: string }> = [];
  $('#results .snippet').each((_index, element) => {
    const resultElement = element;
    const content = resultElement.querySelector('.result-content');
    if (content === null) {
      return;
    }
    const mainLink = directChildAnchor(content);
    if (mainLink === null) {
      return;
    }
    const url = mainLink.getAttribute('href');
    const title = mainLink.querySelector('.search-snippet-title')?.textContent?.trim() ?? '';
    const description = content.querySelector('.generic-snippet')?.textContent?.trim() ?? '';
    const source = mainLink.querySelector('.site-name-wrapper')?.textContent?.trim() ?? '';
    if (title !== '' && url !== null) {
      results.push({ title, url, description, source });
    }
  });
  return results;
}

async function fetchSearchPage(url: string, options: SearchEngineOptions): Promise<string> {
  let response;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(url, {
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
      response = await engineFetch(url, {
        headers: FALLBACK_HEADERS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Brave search request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Brave search request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

export async function searchBrave(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: Array<{ title: string; url: string; description: string; source: string }> = [];
  let pn = 0;
  while (allResults.length < limit) {
    const searchUrl = new URL(BRAVE_BASE_URL);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('source', 'web');
    searchUrl.searchParams.set('offset', String(pn));
    const html = await fetchSearchPage(searchUrl.toString(), options);
    const results = parseBraveResults(html);
    allResults.push(...results);
    if (results.length === 0) {
      console.warn('No more Brave results, ending early.');
      break;
    }
    pn += 1;
  }
  return allResults.slice(0, limit).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  }));
}
