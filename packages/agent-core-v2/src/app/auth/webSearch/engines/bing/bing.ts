/**
 * `auth` domain (cross-cutting) — Bing search engine, ported from the
 * open-websearch project (`engines/bing/bing.js`). Request-mode scraping
 * only: paginates `cn.bing.com/search` HTML through `engineFetch` (or the
 * injected `fetchImpl` in tests), detects anti-bot pages, and parses
 * results with `parseBingSearchResults`. The original playwright
 * interactive-search path and its helpers are not ported.
 */

import type { WebSearchResult } from '#/agent/tools/web-search/web-search';
import { Error2, ErrorCodes } from '#/errors';

import { loadHtml } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { SearchEngineOptions } from '../types';
import { parseBingSearchResults, type BingSearchResult } from './parser';

const BING_BASE_URL = 'https://cn.bing.com/search';
const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const BOT_DETECTION_KEYWORDS = [
  'captcha',
  'verification',
  'verify you are human',
  'access denied',
  'blocked',
  'rate limit',
  'too many requests',
  '请验证',
  '验证码',
  '人机验证',
];

function buildBingSearchUrl(query: string, pageNumber: number): string {
  const url = new URL(BING_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('setlang', 'zh-CN');
  url.searchParams.set('ensearch', '0');
  url.searchParams.set('first', String(1 + pageNumber * 10));
  return url.toString();
}

interface BlockedPageAnalysis {
  blocked: boolean;
  hasResults: boolean;
  detectedKeywords: string[];
  title: string;
}

function analyzeBlockedPage(html: string): BlockedPageAnalysis {
  const normalized = html.toLowerCase();
  const $ = loadHtml(html);
  const title = $('title').first().text().trim().toLowerCase();
  const detectedKeywords = BOT_DETECTION_KEYWORDS.filter((keyword) => normalized.includes(keyword));
  const resultSelector = '#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans';
  const hasStructuredResults = $(resultSelector).length > 0;
  const hasParsedResults = parseBingSearchResults(html, 1).length > 0;
  const hasResults = hasStructuredResults || hasParsedResults;
  const hasCaptchaUi = $(
    [
      'iframe[src*="captcha"]',
      '[id*="captcha"]',
      '[class*="captcha"]',
      'form[action*="validate"]',
      'input[name*="captcha"]',
      '#b_captcha',
      '.b_captcha',
    ].join(','),
  ).length > 0;
  const hasStrongTitleSignal = [
    'captcha',
    'verify you are human',
    'access denied',
    'too many requests',
    '验证码',
    '人机验证',
    '请验证',
  ].some((keyword) => title.includes(keyword));
  const blocked = !hasResults && (hasCaptchaUi || hasStrongTitleSignal || detectedKeywords.length >= 2);
  return {
    blocked,
    hasResults,
    detectedKeywords,
    title,
  };
}

async function fetchSearchPage(url: string, options: SearchEngineOptions): Promise<string> {
  if (options.fetchImpl !== undefined) {
    const response = await options.fetchImpl(url, {
      headers: FALLBACK_HEADERS,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Bing search request failed: HTTP ${String(response.status)}.`, {
        details: { status: response.status },
      });
    }
    return  response.text();
  }
  const response = await engineFetch(url, {
    headers: FALLBACK_HEADERS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Bing search request failed: HTTP ${String(response.status)}.`, {
      details: { status: response.status },
    });
  }
  return  response.text();
}

async function searchBingWithHttp(
  query: string,
  limit: number,
  options: SearchEngineOptions,
): Promise<BingSearchResult[]> {
  const allResults: BingSearchResult[] = [];
  let pageNumber = 0;
  while (allResults.length < limit) {
    let html: string;
    try {
      html = await fetchSearchPage(buildBingSearchUrl(query, pageNumber), options);
    } catch (error) {
      if (error instanceof Error2) {
        throw error;
      }
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Bing search request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const pageState = analyzeBlockedPage(html);
    if (pageState.blocked) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Bing returned a verification or anti-bot page (title: ${pageState.title || 'unknown'}, keywords: ${pageState.detectedKeywords.join(', ') || 'none'})`,
      );
    }
    if (pageState.hasResults && pageState.detectedKeywords.length > 0) {
      console.warn(
        `Bing page contains suspicious keywords but also has results, skipping block detection: ${pageState.detectedKeywords.join(', ')}`,
      );
    }
    const results = parseBingSearchResults(html, limit - allResults.length);
    allResults.push(...results);
    if (results.length === 0) {
      console.warn('No more Bing results from HTTP mode, ending early.');
      break;
    }
    pageNumber += 1;
  }
  return allResults.slice(0, limit);
}

function toWebSearchResult(result: BingSearchResult): WebSearchResult {
  return {
    title: result.title,
    url: result.url,
    snippet: result.description,
    siteName: result.source || undefined,
  };
}

export async function searchBing(
  query: string,
  limit: number,
  options: SearchEngineOptions = {},
): Promise<WebSearchResult[]> {
  const results = await searchBingWithHttp(query, limit, options);
  return results.map((result) => toWebSearchResult(result));
}
