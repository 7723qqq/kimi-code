/**
 * `auth` domain (cross-cutting) — CSDN article fetcher, ported from the
 * open-websearch project (`engines/csdn/fetchCsdnArticle.js`). Request-mode
 * only: fetches the article HTML through `engineFetch` (or the injected
 * `fetchImpl` in tests) and extracts the `#content_views` body text with the
 * linkedom shim. The original cookie-retry and playwright browser fallbacks
 * are not ported. Network/HTTP failures throw `Error2`
 * (`WEB_FETCH_FAILED`); pages with no extractable content return `undefined`.
 */

import { Error2, ErrorCodes } from '#/errors';

import { loadHtml, type EngineElement, type EngineQueryResult } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { ArticleFetchFn, SearchEngineOptions } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  Accept: '*/*',
  Host: 'blog.csdn.net',
  Connection: 'keep-alive',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

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
  const article = $('#content_views').first();
  removeAll(article, 'script, style, noscript');
  return normalizeExtractedText(article.text());
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
      `CSDN article request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `CSDN article request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function fetchCsdnArticleImpl(
  url: string,
  options: SearchEngineOptions,
): Promise<{ content: string } | undefined> {
  const html = await fetchArticleHtml(url, options);
  const content = extractArticleContent(html);
  if (content === '' || (looksLikeBotChallengePage(html) && content.length < 200)) {
    return undefined;
  }
  return { content };
}

export const fetchCsdnArticle: ArticleFetchFn = (url, options = {}) =>
  fetchCsdnArticleImpl(url, options);
