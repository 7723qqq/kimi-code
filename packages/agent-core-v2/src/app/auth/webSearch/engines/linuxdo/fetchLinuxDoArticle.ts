import { Error2, ErrorCodes } from '#/errors';

import { loadHtml } from '../engine-html';
import { engineFetch } from '../engine-http';
import type { ArticleFetchFn, SearchEngineOptions } from '../types';

const REQUEST_TIMEOUT_MS = 30_000;

const FALLBACK_HEADERS: Record<string, string> = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'zh-CN,zh;q=0.9',
  'cache-control': 'no-cache',
  'discourse-track-view': 'true',
  pragma: 'no-cache',
  referer: 'https://linux.do/search',
  'sec-ch-ua': '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
  Host: 'linux.do',
  Connection: 'keep-alive',
};

interface LinuxDoTopicResponse {
  post_stream?: { posts?: Array<{ cooked?: string }> };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

async function fetchTopicJson(topicId: string, options: SearchEngineOptions): Promise<string> {
  const apiUrl = `https://linux.do/t/${topicId}.json`;
  let response;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(apiUrl, {
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
      response = await engineFetch(apiUrl, {
        headers: FALLBACK_HEADERS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `LinuxDo topic request to ${apiUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `LinuxDo topic request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function fetchLinuxDoArticleImpl(
  url: string,
  options: SearchEngineOptions,
): Promise<{ content: string } | undefined> {
  const match = url.match(/\/topic\/(\d+)/);
  const topicId = match?.[1] ?? null;
  if (topicId === null) {
    throw new Error('Invalid URL: Cannot extract topic ID.');
  }
  const body = await fetchTopicJson(topicId, options);
  let parsed: LinuxDoTopicResponse;
  try {
    parsed = JSON.parse(body) as LinuxDoTopicResponse;
  } catch (error) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `LinuxDo topic request returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const cookedHtml = parsed.post_stream?.posts?.[0]?.cooked ?? '';
  if (cookedHtml === '') {
    return undefined;
  }
  const $ = loadHtml(cookedHtml);
  const plainText = $('body').text().trim();
  return { content: plainText };
}

export const fetchLinuxDoArticle: ArticleFetchFn = (url, options = {}) =>
  fetchLinuxDoArticleImpl(url, options);
