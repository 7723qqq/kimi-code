/**
 * `auth` domain (cross-cutting) — CSDN search engine, ported from the
 * open-websearch project (`engines/csdn/csdn.js`). Request-mode only:
 * paginates the `so.csdn.net/api/v3/search` JSON API through `engineFetch`
 * (or the injected `fetchImpl` in tests) and maps the `result_vos` array.
 * The original has no playwright path, so nothing is skipped. HTTP/network
 * failures throw `Error2` (`WEB_FETCH_FAILED`); pages that yield no
 * parseable results end the pagination loop early.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';

const CSDN_SEARCH_URL = 'https://so.csdn.net/api/v3/search';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  Pragma: 'no-cache',
  Cookie:
    'uuid_tt_dd=10_20283040220-1750745713898-623562; dc_session_id=10_1750745713898.508399; dc_sid=0aa6fae5250c4389fac68320b1cb43b2; waf_captcha_marker=1b4e9099857d7aedf0941f03fa70bfb22ea2153f7fa053b8101ed28dc1504b11; c_pref=default; c_ref=default; fid=20_93458541565-1750745714849-027048; c_first_ref=default; c_first_page=https%3A//so.csdn.net/so/search%3Fq%3Dweb%2520search%2520mcp; c_dsid=11_1750745714849.980720; c_segment=10; c_page_id=default; creative_btn_mp=1; log_Id_view=9; fe_request_id=1750745715289_2973_2073791; dc_tos=syck1f; log_Id_pv=1; log_Id_click=1; uuid_tt_dd=10_20283045860-1751096847125-425142; dc_session_id=10_1751096847125.891975',
  'User-Agent': 'Apifox/1.0.0 (https://apifox.com)',
  Accept: '*/*',
  Host: 'so.csdn.net',
  Connection: 'keep-alive',
};

interface CsdnSearchResultItem {
  title?: string;
  url_location?: string;
  digest?: string;
  nickname?: string;
}

interface CsdnSearchResponse {
  result_vos?: CsdnSearchResultItem[];
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchSearchPage(
  query: string,
  page: number,
  options: SearchEngineOptions,
): Promise<string> {
  const searchUrl = new URL(CSDN_SEARCH_URL);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('p', String(page));
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
      `CSDN search request to ${searchUrl.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `CSDN search request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

export async function searchCsdn(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const allResults: WebSearchResult[] = [];
  let pn = 1;
  while (allResults.length < limit) {
    const body = await fetchSearchPage(query, pn, options);
    let parsed: CsdnSearchResponse;
    try {
      parsed = JSON.parse(body) as CsdnSearchResponse;
    } catch (error) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `CSDN search request returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const resultVos = parsed.result_vos;
    if (!Array.isArray(resultVos)) {
      break;
    }
    const results: WebSearchResult[] = [];
    for (const item of resultVos) {
      if (item.title === undefined || item.url_location === undefined) {
        continue;
      }
      results.push({
        title: item.title,
        url: item.url_location,
        snippet: item.digest ?? '',
        siteName: item.nickname ?? undefined,
      });
    }
    allResults.push(...results);
    if (results.length === 0) {
      console.warn('No more CSDN results, ending early.');
      break;
    }
    pn += 1;
  }
  return allResults.slice(0, limit);
}
