import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { fetch as undiciFetch } from '#/_base/utils/undici-npm';
import { Error2, ErrorCodes } from '#/errors';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../tools/fetch-url-types';

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

interface DomElementLike {
  textContent: string | null;
  querySelector(selector: string): DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;

const MAX_REDIRECT_HOPS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SYSTEM_HOST_TIMERS: IHostTimers = {
  _serviceBrand: undefined,
  setClampedTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: FetchLike;
  maxBytes?: number;

  timeoutMs?: number;

  timers?: IHostTimers;
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly timers: IHostTimers;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timers = options.timers ?? SYSTEM_HOST_TIMERS;
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    const response = await this.requestWithRedirects(url, options?.signal);
    return this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<UrlFetchResult> {
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {});
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw tooLargeError(cl, this.maxBytes);
      }
    }

    const body = stripBom(await readBodyWithCap(response.body, this.maxBytes));

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  private async requestWithRedirects(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      validateFetchUrl(currentUrl);
      const response = await this.fetchWithDeadline(currentUrl, signal, deadline);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      await response.body?.cancel().catch(() => {});
      if (redirects >= MAX_REDIRECT_HOPS) {
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          `Too many redirects while fetching "${url}" (limit ${String(MAX_REDIRECT_HOPS)}).`,
          { details: { url, limit: MAX_REDIRECT_HOPS } },
        );
      }
      redirects += 1;
      currentUrl = new URL(location, currentUrl).toString();
    }
  }

  private async fetchWithDeadline(
    url: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fetchTimeoutError(url, this.timeoutMs);
    const controller = new AbortController();
    const timer: IHostTimerHandle = this.timers.setTimeout(() => {
      controller.abort();
    }, remaining);
    try {
      const hopSignal =
        signal !== undefined ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal: hopSignal,
        redirect: 'manual',
      } as RequestInit);
    } catch (error) {
      if (controller.signal.aborted && signal?.aborted !== true) {
        throw fetchTimeoutError(url, this.timeoutMs);
      }
      throw error;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  private extractMainContent(html: string): string {
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {}

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}

function tooLargeError(bytes: number, maxBytes: number): Error2 {
  return new Error2(
    ErrorCodes.WEB_FETCH_FAILED,
    `Response body too large: ${String(bytes)} bytes exceeds maxBytes (${String(maxBytes)}).`,
    { details: { bytes, maxBytes } },
  );
}

function fetchTimeoutError(url: string, timeoutMs: number): Error2 {
  return new Error2(
    ErrorCodes.WEB_FETCH_FAILED,
    `Fetching "${url}" timed out after ${String(timeoutMs)}ms.`,
    { details: { url, timeoutMs } },
  );
}

async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLargeError(total, maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function validateFetchUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error2(ErrorCodes.WEB_INVALID_URL, `Invalid URL: "${url}"`, { details: { url } });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error2(
      ErrorCodes.WEB_INVALID_URL,
      `Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`,
      { details: { url, protocol: parsed.protocol } },
    );
  }
}
