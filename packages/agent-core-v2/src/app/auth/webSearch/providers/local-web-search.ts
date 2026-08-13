/**
 * `auth` domain (cross-cutting) — keyless multi-engine `WebSearchProvider`
 * fallback.
 *
 * Integrated from the open-websearch project's approach: scrapes public
 * search endpoints that need no API key — DuckDuckGo's HTML endpoint and
 * Bing's HTML search — with a browser-like User-Agent. Used whenever no
 * Moonshot search backend is configured so `WebSearch` stays available to
 * every session; the Moonshot backend still wins when present.
 *
 * Engine selection: `KIMI_CODE_SEARCH_ENGINE=bing|duckduckgo` (default
 * `duckduckgo` — Bing's HTML pages are more aggressively bot-gated and the
 * fallback engine is picked when the primary returns nothing). Results are
 * parsed with linkedom; search engines wrap result links in redirectors
 * (DuckDuckGo `/l/?uddg=`, Bing `/ck/a?u=`), which are decoded back to the
 * real target. An empty or challenge page yields an empty result list
 * instead of throwing, so the model sees "no results" rather than a hard
 * failure.
 */

import { parseHTML as rawParseHTML } from 'linkedom';

import { Error2, ErrorCodes } from '#/errors';
import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BING_SEARCH_URL = 'https://cn.bing.com/search';

export type LocalSearchEngine = 'duckduckgo' | 'bing';

export function resolveSearchEngine(env: Record<string, string | undefined> = process.env): LocalSearchEngine {
  const raw = env['KIMI_CODE_SEARCH_ENGINE']?.trim().toLowerCase();
  return raw === 'bing' ? 'bing' : 'duckduckgo';
}

interface DdgDom {
  document: {
    querySelectorAll(selector: string): readonly DdgElement[];
  };
}
interface DdgElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DdgElement | null;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DdgDom;

export interface LocalWebSearchProviderOptions {
  fetchImpl?: typeof fetch;
  /** Engine override; defaults to `KIMI_CODE_SEARCH_ENGINE` or duckduckgo. */
  engine?: LocalSearchEngine;
}

export class LocalWebSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly engine: LocalSearchEngine;

  constructor(options: LocalWebSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.engine = options.engine ?? resolveSearchEngine();
  }

  async search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const primary =
      this.engine === 'bing' ? searchBing(this.fetchImpl, query, options?.signal) : searchDuckDuckGo(this.fetchImpl, query, options?.signal);
    const results = await primary;
    if (results.length > 0) return results;
    // Primary engine came back empty (challenge / no results): try the other
    // keyless engine before giving up.
    const fallback =
      this.engine === 'bing' ? searchDuckDuckGo(this.fetchImpl, query, options?.signal) : searchBing(this.fetchImpl, query, options?.signal);
    return fallback;
  }
}

async function getText(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; status: number; text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Search request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, text: '' };
  }
  return { ok: true, status: response.status, text: await response.text() };
}

// ── DuckDuckGo (HTML endpoint) ──────────────────────────────────────────────

async function searchDuckDuckGo(
  fetchImpl: typeof fetch,
  query: string,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const url = `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const { ok, status, text } = await getText(fetchImpl, url, signal);
  if (!ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `DuckDuckGo search request failed: HTTP ${String(status)}`,
      { details: { status } },
    );
  }
  return parseDuckDuckGoResults(text);
}

export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const { document } = parseHTML(html);
  const results: WebSearchResult[] = [];
  for (const result of document.querySelectorAll('.result')) {
    const link = result.querySelector('.result__a');
    if (link === null) continue;
    const title = (link.textContent ?? '').trim();
    if (title.length === 0) continue;
    const href = link.getAttribute('href') ?? '';
    const url = decodeDuckDuckGoRedirect(href);
    if (url === undefined) continue;
    // Skip sponsored links (DuckDuckGo serves them through its ad redirector).
    if (url.includes('/y.js') || url.includes('ad_domain=')) continue;
    const snippetEl = result.querySelector('.result__snippet');
    const snippet = (snippetEl?.textContent ?? '').trim();
    results.push({
      title,
      url,
      snippet: snippet.length > 0 ? snippet : title,
    });
    if (results.length >= 10) break;
  }
  return results;
}

/** DuckDuckGo wraps result links in its redirector: `/l/?uddg=<encoded url>`. */
function decodeDuckDuckGoRedirect(href: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    if (target !== null && (target.startsWith('http://') || target.startsWith('https://'))) {
      return target;
    }
  } catch {
    // fall through to the raw href
  }
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

// ── Bing (HTML endpoint) ────────────────────────────────────────────────────

async function searchBing(
  fetchImpl: typeof fetch,
  query: string,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const url = new URL(BING_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('setlang', 'zh-CN');
  url.searchParams.set('ensearch', '0');
  const { ok, status, text } = await getText(fetchImpl, url.toString(), signal);
  if (!ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `Bing search request failed: HTTP ${String(status)}`,
      { details: { status } },
    );
  }
  return parseBingResults(text);
}

export function parseBingResults(html: string): WebSearchResult[] {
  const { document } = parseHTML(html);
  const results: WebSearchResult[] = [];
  for (const result of document.querySelectorAll('#b_results li.b_algo')) {
    const heading = result.querySelector('h2 a');
    if (heading === null) continue;
    const title = (heading.textContent ?? '').trim();
    if (title.length === 0) continue;
    const rawUrl = heading.getAttribute('href') ?? '';
    const url = decodeBingRedirect(rawUrl);
    if (url === undefined) continue;
    const snippetEl = result.querySelector('.b_caption p, .b_lineclamp2, .b_paractl');
    const snippet = (snippetEl?.textContent ?? '').trim();
    results.push({
      title,
      url,
      snippet: snippet.length > 0 ? snippet : title,
    });
    if (results.length >= 10) break;
  }
  return results;
}

/** Bing wraps result links as `/ck/a?u=<base64url>`; decode the real target. */
function decodeBingRedirect(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed, 'https://cn.bing.com');
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname.startsWith('/ck/a')) {
      const encoded = parsed.searchParams.get('u') ?? '';
      const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
      try {
        const decoded = Buffer.from(payload, 'base64url').toString('utf8').trim();
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
      } catch {
        // fall through
      }
      return undefined;
    }
  } catch {
    // fall through to the raw URL
  }
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `https://cn.bing.com${trimmed}`;
  return trimmed;
}
