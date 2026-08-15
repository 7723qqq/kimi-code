/**
 * `auth` domain (cross-cutting) — Zhihu article fetcher, ported from the
 * open-websearch project (`engines/zhihu/fetchZhihuArticle.js`).
 * Request-mode only: validates the `/p/<id>` article URL, fetches the
 * article HTML through `engineFetch` (or the injected `fetchImpl` in
 * tests), and extracts the body text from the first matching content
 * selector (`#content`, `.RichText.ztext`, `article`, `main`) with the
 * linkedom shim. The original cookie-retry and playwright browser
 * fallbacks are not ported. Network/HTTP failures throw `Error2`
 * (`WEB_FETCH_FAILED`); invalid URLs throw a plain `Error`, and pages with
 * no extractable content return `undefined`.
 */

import { Error2, ErrorCodes } from '#/errors';

import { loadHtml, type EngineElement, type EngineQueryResult } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { ArticleFetchFn, SearchEngineOptions } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Chromium";v="145", "Google Chrome";v="145", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'accept-language': 'zh-CN,zh;q=0.9',
};

const CONTENT_SELECTORS = ['#content', '.RichText.ztext', 'article', 'main'];

const BOT_KEYWORDS = [
  'captcha',
  'verification',
  'verify you are human',
  'access denied',
  'blocked',
  'rate limit',
  'too many requests',
  'please enable javascript',
  'please verify',
  '请验证',
  '验证码',
  '人机验证',
  '安全验证',
];

function normalizeExtractedText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[ \t]+\n/g, '\n')
    .replaceAll(/\n[ \t]+/g, '\n')
    .replaceAll(/[ \t]{2,}/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function removeAll(result: EngineQueryResult, selector: string): void {
  for (const element of result.find(selector).toArray()) {
    (element as EngineElement & { remove(): void }).remove();
  }
}

function extractArticleContent(html: string): string {
  const $ = loadHtml(html);
  for (const selector of CONTENT_SELECTORS) {
    const element = $(selector).first();
    if (element.length === 0) {
      continue;
    }
    removeAll(element, 'script, style, noscript');
    const content = normalizeExtractedText(element.text());
    if (content.length > 0) {
      return content;
    }
  }
  return '';
}

function looksLikeBotChallengePage(html: string): boolean {
  const normalized = html.toLowerCase();
  return BOT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchArticleHtml(url: string, options: SearchEngineOptions): Promise<string> {
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
      `Zhihu article request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Zhihu article request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function fetchZhihuArticleImpl(
  url: string,
  options: SearchEngineOptions,
): Promise<{ content: string } | undefined> {
  const match = url.match(/\/p\/(\d+)/);
  if (match === null) {
    throw new Error('Invalid URL: Cannot extract article ID.');
  }
  const html = await fetchArticleHtml(url, options);
  const content = extractArticleContent(html);
  if (content === '' || (looksLikeBotChallengePage(html) && content.length < 200)) {
    return undefined;
  }
  return { content };
}

export const fetchZhihuArticle: ArticleFetchFn = (url, options = {}) =>
  fetchZhihuArticleImpl(url, options);
