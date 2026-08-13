/**
 * `auth` domain (cross-cutting) — DuckDuckGo SERP parser, ported from the
 * open-websearch project (`engines/duckduckgo/searchDuckDuckGo.js`).
 * Extracts organic results from the html.duckduckgo.com result page through
 * the linkedom shim (`loadHtml`): `div.result` items with `a.result__a`
 * title links, `.result__snippet` descriptions, `.result__url` sources, ad
 * exclusion via the `result--ad` class, and `/l/` redirect decoding through
 * the `uddg` query parameter. Also parses the `d.js` JSONP payload used by
 * the preload endpoint (`DDG.pageLayout.load('d', …)`) and validates
 * preload URLs against DDG's own `links.duckduckgo.com/d.js` endpoint.
 */

import { loadHtml } from '../engine-html';

export interface DuckDuckGoSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'duckduckgo';
}

/** One entry of the `d.js` JSONP payload; `t`/`u`/`a`/`i`/`sn` map to title, url, snippet, icon, site name. */
interface DuckDuckGoJsonItem {
  /** Present on navigation-only entries, which are skipped. */
  n?: unknown;
  t?: string;
  u?: string;
  a?: string;
  i?: string;
  sn?: string;
}

const JSONP_PATTERN = /DDG\.pageLayout\.load\('d',\s*(\[.*?\])\s*\);/s;

const PRELOAD_URL_PATTERN = /https:\/\/links\.duckduckgo\.com\/d\.js\?[^"'<>]+/i;

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function hasClass(element: { getAttribute(name: string): string | null }, className: string): boolean {
  const classList = element.getAttribute('class');
  return classList !== null && classList.split(/\s+/).includes(className);
}

/** The preload URL is only trusted when it points at DDG's own `d.js` endpoint. */
export function isTrustedDuckDuckGoPreloadUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'links.duckduckgo.com' &&
      (parsed.port === '' || parsed.port === '443') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/d.js'
    );
  } catch {
    return false;
  }
}

/**
 * Resolves a result link: protocol-relative `//` URLs get `https:` and
 * DuckDuckGo `/l/` redirector links are decoded through their `uddg`
 * parameter, dropping the redirector when the target is missing or not
 * http(s).
 */
function sanitizeDuckDuckGoUrl(rawUrl: string | null | undefined): string {
  if (rawUrl === null || rawUrl === undefined) {
    return '';
  }
  let resolvedUrl = rawUrl.trim();
  if (resolvedUrl === '') {
    return '';
  }
  if (resolvedUrl.startsWith('//')) {
    resolvedUrl = `https:${resolvedUrl}`;
  }
  try {
    const url = new URL(resolvedUrl);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')?.trim();
      if (target) {
        let decodedTarget = target;
        try {
          decodedTarget = decodeURIComponent(target);
        } catch {
          // `uddg` was already decoded by the query-string parser
        }
        if (decodedTarget.startsWith('http://') || decodedTarget.startsWith('https://')) {
          return decodedTarget;
        }
      }
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Finds the trusted preload `d.js` URL in the DuckDuckGo search page: first
 * through `link[rel="preload"]` / `#deep_preload_script` markup, then as a
 * regex fallback over the raw HTML. Returns '' when no trusted URL is found.
 */
export function extractDuckDuckGoPreloadUrl(pageHtml: string): string {
  const $ = loadHtml(pageHtml);
  for (const el of $('link[rel="preload"]').toArray()) {
    const href = el.getAttribute('href');
    if (href !== null && isTrustedDuckDuckGoPreloadUrl(href)) {
      return href;
    }
  }
  for (const el of $('#deep_preload_script').toArray()) {
    const src = el.getAttribute('src');
    if (src !== null && isTrustedDuckDuckGoPreloadUrl(src)) {
      return src;
    }
  }
  const urlMatch = pageHtml.match(PRELOAD_URL_PATTERN);
  if (urlMatch?.[0] !== undefined && isTrustedDuckDuckGoPreloadUrl(urlMatch[0])) {
    return urlMatch[0];
  }
  return '';
}

/** Extracts organic results from one html.duckduckgo.com result page. */
export function parseDuckDuckGoResults(htmlContent: string, limit: number): DuckDuckGoSearchResult[] {
  const $ = loadHtml(htmlContent);
  const results: DuckDuckGoSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const el of $('div.result').toArray()) {
    if (results.length >= limit) {
      break;
    }
    if (hasClass(el, 'result--ad')) {
      continue;
    }
    const titleEl = el.querySelector('a.result__a');
    const title = normalizeWhitespace(titleEl?.textContent ?? '');
    const url = sanitizeDuckDuckGoUrl(titleEl?.getAttribute('href'));
    if (title === '' || url === '' || seenUrls.has(url)) {
      continue;
    }
    const description = normalizeWhitespace(el.querySelector('.result__snippet')?.textContent ?? '');
    const source = normalizeWhitespace(el.querySelector('.result__url')?.textContent ?? '');
    seenUrls.add(url);
    results.push({ title, url, description, source, engine: 'duckduckgo' });
  }
  return results;
}

/** Parses one `d.js` JSONP payload (`DDG.pageLayout.load('d', …)`); navigation entries are skipped. */
export function parseDuckDuckGoJsonp(jsonpText: string): DuckDuckGoSearchResult[] {
  const jsonpMatch = jsonpText.match(JSONP_PATTERN);
  if (jsonpMatch === null || jsonpMatch[1] === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonpMatch[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const results: DuckDuckGoSearchResult[] = [];
  for (const rawItem of parsed) {
    if (typeof rawItem !== 'object' || rawItem === null) {
      continue;
    }
    const item = rawItem as DuckDuckGoJsonItem;
    if (item.n) {
      continue;
    }
    results.push({
      title: item.t ?? '',
      url: item.u ?? '',
      description: item.a ?? '',
      source: item.i ?? item.sn ?? '',
      engine: 'duckduckgo',
    });
  }
  return results;
}
