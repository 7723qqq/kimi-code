import { lookup as callbackLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';
import { Agent, fetch as undiciFetch, type Dispatcher } from '#/_base/utils/undici-npm';

import { isBlockedIpAddress } from '#/_base/utils/private-address';
import { isProxyConfigured, makeNoProxyMatcher, resolveNoProxy } from '#/_base/utils/proxy';
import { Error2, ErrorCodes } from '#/errors';

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

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  allowPrivateAddresses?: boolean;
  /** Budget shared by the whole fetch call, across all redirect hops. */
  timeoutMs?: number;
}

/**
 * UrlFetcher with SSRF guards: literal private/loopback addresses and
 * `.localhost` hosts are refused outright, and hostnames are resolved and
 * checked against a private-address blocklist before each hop. When undici's
 * global proxy dispatcher (`installGlobalProxyDispatcher`) carries the
 * request instead of a per-request pinned Agent, that resolution step is
 * skipped — resolved addresses are discarded anyway (no pinning is
 * possible), while a poisoned or unreachable local DNS, common exactly on
 * networks that need a proxy, would fail the request before it starts; the
 * literal-IP and localhost refusals still apply on that path. One predicate
 * decides whether a host:port rides the global proxy, shared by the SSRF
 * pre-check and the dispatcher selection so both agree on when DNS pinning
 * applies.
 *
 * The default fetch is undici's own `fetch` rather than `globalThis.fetch`:
 * the pinned-DNS `dispatcher` option only exists in undici, and on runtimes
 * whose global fetch is not undici (Bun) it would be ignored — silently
 * dropping DNS pinning and re-resolving through whatever resolver the runtime
 * prefers. Pinning the implementation keeps Node and Bun semantics identical.
 *
 * The whole call runs against one shared deadline (`timeoutMs`, default
 * 30s): every redirect hop gets the remaining budget, a hung server surfaces
 * as a "timed out" error instead of riding undici's multi-minute defaults,
 * and response bodies are streamed with the same `maxBytes` cap applied
 * incrementally rather than buffered first.
 */
export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;
  private readonly timeoutMs: number;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult> {
    const dispatchers: Dispatcher[] = [];
    try {
      const response = await this.requestWithValidatedRedirects(
        url,
        options?.signal,
        dispatchers,
      );
      return await this.readResponse(response);
    } finally {
      await Promise.all(
        dispatchers.map((dispatcher) =>
          dispatcher.close().catch(() => {
          }),
        ),
      );
    }
  }

  private async readResponse(response: Response): Promise<UrlFetchResult> {
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => {
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        await response.body?.cancel().catch(() => {
        });
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

  private async requestWithValidatedRedirects(
    url: string,
    signal: AbortSignal | undefined,
    dispatchers: Dispatcher[],
  ): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      const target = await resolveSafeFetchTarget(currentUrl, this.allowPrivateAddresses);
      const response = await this.fetchWithDeadline(currentUrl, target, signal, dispatchers, deadline);
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
    target: SafeFetchTarget,
    signal: AbortSignal | undefined,
    dispatchers: Dispatcher[],
    deadline: number,
  ): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fetchTimeoutError(url, this.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => {
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
        dispatcher: this.pinnedDispatcherFor(target, dispatchers) as unknown,
      } as RequestInit);
    } catch (error) {
      if (controller.signal.aborted && signal?.aborted !== true) {
        throw fetchTimeoutError(url, this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private pinnedDispatcherFor(
    target: SafeFetchTarget,
    dispatchers: Dispatcher[],
  ): Dispatcher | undefined {
    if (target.addresses === undefined) return undefined;
    if (requestRidesGlobalProxy(target.host, target.port)) return undefined;
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup(target.host, target.addresses) },
    });
    dispatchers.push(dispatcher);
    return dispatcher;
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
    } catch {
    }

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

interface SafeFetchTarget {
  host: string;
  port: string;
  addresses?: LookupAddress[];
}

async function resolveSafeFetchTarget(url: string, allowPrivate: boolean): Promise<SafeFetchTarget> {
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
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  if (allowPrivate) return { host, port };
  if (isIP(host) !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new Error2(ErrorCodes.WEB_PRIVATE_ADDRESS, `Refusing to fetch private address: "${host}"`, {
        details: { host },
      });
    }
    return { host, port };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error2(ErrorCodes.WEB_PRIVATE_ADDRESS, `Refusing to fetch private host: "${host}"`, {
      details: { host },
    });
  }
  if (requestRidesGlobalProxy(host, port)) return { host, port };
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error2(
      ErrorCodes.WEB_PRIVATE_ADDRESS,
      `Cannot resolve host "${host}" for the fetch safety check: ${detail}`,
      { cause: error, details: { host } },
    );
  }
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new Error2(
        ErrorCodes.WEB_PRIVATE_ADDRESS,
        `Refusing to fetch host "${host}": resolves to private address "${address}".`,
        { details: { host, address } },
      );
    }
  }
  return { host, port, addresses };
}

function requestRidesGlobalProxy(host: string, port: string): boolean {
  return (
    isProxyConfigured(process.env) && !makeNoProxyMatcher(resolveNoProxy(process.env))(host, port)
  );
}

function pinnedLookup(host: string, addresses: LookupAddress[]): LookupFunction {
  return (hostname: string, options: LookupOptions | undefined, callback: PinnedLookupCallback) => {
    if (hostname !== host) {
      callbackLookup(hostname, options ?? {}, callback);
      return;
    }
    if (options?.all === true) {
      callback(null, [...addresses]);
      return;
    }
    const single = addresses.find((entry) => entry.family === options?.family) ?? addresses[0]!;
    callback(null, single.address, single.family);
  };
}

type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrList: string | LookupAddress[],
  family?: number,
) => void;
