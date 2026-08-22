import { Error2, ErrorCodes } from '#/errors';

import { loadHtml, type EngineElement, type EngineQueryResult } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { ArticleFetchFn, SearchEngineOptions } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  Connection: 'keep-alive',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  pragma: 'no-cache',
  'cache-control': 'no-cache',
  'upgrade-insecure-requests': '1',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'accept-language': 'zh-CN,zh;q=0.9',
  priority: 'u=0, i',
};

const CONTENT_SELECTORS = [
  '.markdown-body',
  '.article-content',
  '.content',
  '[data-v-md-editor-preview]',
  '.bytemd-preview',
  '.article-area .content',
  '.main-area .article-area',
  '.article-wrapper .content',
];

function removeAll(result: EngineQueryResult, selector: string): void {
  for (const element of result.find(selector).toArray()) {
    (element as EngineElement & { remove(): void }).remove();
  }
}

function extractArticleContent(html: string): string {
  const $ = loadHtml(html);
  let content = '';
  for (const selector of CONTENT_SELECTORS) {
    const element = $(selector).first();
    if (element.length > 0) {
      removeAll(element, 'script, style, .code-block-extension, .hljs-ln-numbers');
      content = element.text().trim();
      if (content.length > 100) {
        break;
      }
    }
  }
  if (content === '' || content.length < 100) {
    removeAll($('script, style, nav, header, footer, .sidebar, .comment'), '');
    const body = $('body');
    content = body.length > 0 ? body.text().trim() : '';
  }
  return content;
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
      `Juejin article request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Juejin article request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function fetchJuejinArticleImpl(
  url: string,
  options: SearchEngineOptions,
): Promise<{ content: string } | undefined> {
  const html = await fetchArticleHtml(url, options);
  const content = extractArticleContent(html);
  if (content === '') {
    return undefined;
  }
  return { content };
}

export const fetchJuejinArticle: ArticleFetchFn = (url, options = {}) =>
  fetchJuejinArticleImpl(url, options);
