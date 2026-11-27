import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { fetch as undiciFetch } from '#/_base/utils/undici-npm';
import { Error2, ErrorCodes } from '#/errors';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';

import {
  extractMarkdownTitle,
  rankPassages,
  type WebCache,
} from '../cache/webCache';
import {
  HttpFetchError,
  type UrlFetchKind,
  type UrlFetchOptions,
  type UrlFetchResult,
  type UrlFetcher,
} from '../tools/fetch-url-types';
import { extractPdfText } from './pdf-extract';

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
const DEFAULT_MAX_OUTPUT_CHARS = 48_000;
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
  maxOutputChars?: number;
  timeoutMs?: number;
  timers?: IHostTimers;
  cache?: WebCache;
  cacheTtlMs?: number;
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxBytes: number;
  private readonly maxOutputChars: number;
  private readonly timeoutMs: number;
  private readonly timers: IHostTimers;
  private readonly cache: WebCache | undefined;
  private readonly cacheTtlMs: number | undefined;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timers = options.timers ?? SYSTEM_HOST_TIMERS;
    this.cache = options.cache;
    this.cacheTtlMs = options.cacheTtlMs;
  }

  async fetch(url: string, options?: UrlFetchOptions): Promise<UrlFetchResult> {
    if (options?.bypassCache !== true && this.cache !== undefined) {
      const hit = this.cache.get(url);
      if (hit !== undefined) {
        return {
          content: this.shapeOutput(hit.content, url, hit.title, options),
          kind: hit.kind,
          title: hit.title,
          cached: true,
        };
      }
    }

    const response = await this.requestWithRedirects(url, options?.signal);
    const { rawContent, kind, contentType, title } = await this.readResponse(response, url);
    if (this.cache !== undefined) {
      this.cache.put({
        url,
        title,
        content: rawContent,
        kind,
        contentType,
        ttlMs: this.cacheTtlMs,
      });
    }
    return {
      content: this.shapeOutput(rawContent, url, title, options),
      kind,
      title,
    };
  }

  private shapeOutput(
    rawContent: string,
    url: string,
    title: string,
    options: UrlFetchOptions | undefined,
  ): string {
    const query = options?.query?.trim();
    const limit = Math.max(500, options?.maxChars ?? this.maxOutputChars);
    if (query !== undefined && query.length > 0 && rawContent.length > 0) {
      const passages = rankPassages(
        query,
        [{ url, title: title.length > 0 ? title : extractMarkdownTitle(rawContent), content: rawContent }],
        6,
      );
      if (passages.length > 0) {
        const blocks = passages.map((passage, index) => {
          const headingPart = passage.heading.length > 0 ? ` — ${passage.heading}` : '';
          return `[Excerpt ${String(index + 1)}${headingPart}]\n${passage.text}`;
        });
        const joined = blocks.join('\n\n');
        return joined.length <= limit ? joined : `${joined.slice(0, limit)}\n\n[Truncated at ${String(limit)} chars.]`;
      }
    }
    if (rawContent.length <= limit) return rawContent;
    return `${rawContent.slice(0, limit)}\n\n[Content truncated at ${String(limit)} of ${String(rawContent.length)} chars. Pass \`query\` to extract specific passages.]`;
  }

  private async readResponse(
    response: Response,
    url: string,
  ): Promise<{ rawContent: string; kind: UrlFetchKind; contentType: string; title: string }> {
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

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const rawBytes = await readBytesWithCap(response.body, this.maxBytes);

    if (
      contentType.includes('application/pdf') ||
      (rawBytes.length >= 5 &&
        rawBytes[0] === 0x25 &&
        rawBytes[1] === 0x50 &&
        rawBytes[2] === 0x44 &&
        rawBytes[3] === 0x46 &&
        rawBytes[4] === 0x2d)
    ) {
      const pdfText = extractPdfText(rawBytes);
      return {
        rawContent: pdfText,
        kind: 'extracted',
        contentType: 'application/pdf',
        title: url.split('/').pop() ?? url,
      };
    }

    const body = stripBom(Buffer.from(rawBytes).toString('utf8'));

    if (contentType.includes('application/json') || contentType.includes('+json')) {
      return {
        rawContent: formatJsonBody(body),
        kind: 'passthrough',
        contentType,
        title: url,
      };
    }

    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return {
        rawContent: body,
        kind: 'passthrough',
        contentType,
        title: extractMarkdownTitle(body),
      };
    }

    const extracted = this.extractMainContent(body);
    return {
      rawContent: extracted,
      kind: 'extracted',
      contentType,
      title: extractMarkdownTitle(extracted),
    };
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

function formatJsonBody(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
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

async function readBytesWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
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
  return Buffer.concat(chunks);
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
