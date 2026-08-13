/**
 * `auth` domain (cross-cutting) — Bing SERP parser, ported from the
 * open-websearch project (`engines/bing/parser.js`). Extracts organic
 * results from Bing result pages through the linkedom shim (`loadHtml`):
 * layered result selectors, `/ck/a` redirect decoding (base64url `u`
 * parameter), tracking-parameter stripping, and URL dedup. The shim's
 * query layer omits cheerio's `closest`/`hasClass`, so both are emulated
 * over the linkedom DOM (`closestElement` / `hasClass`).
 */

import { Buffer } from 'node:buffer';

import { loadHtml, type EngineElement, type EngineQueryResult } from '../engine-html';

export interface BingSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'bing';
}

const RESULT_SELECTORS = [
  '#b_results > li.b_algo',
  '#b_results > li.b_ans',
  '#b_results > li:not(.b_ad):not(.b_pag):not(.b_msg)',
  '#b_topw > li.b_algo',
  '#b_topw > li.b_ans',
  '.b_algo',
  '.b_ans',
];

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function hasClass(element: EngineElement, className: string): boolean {
  const classList = element.getAttribute('class');
  return classList !== null && classList.split(/\s+/).includes(className);
}

/** Emulates cheerio's `closest` over the linkedom DOM. */
function closestElement(element: EngineElement, selector: string): EngineElement | null {
  let current: EngineElement | null = element;
  while (current !== null) {
    const candidate = current as EngineElement & { matches?: (selector: string) => boolean };
    if (candidate.matches !== undefined && candidate.matches(selector)) {
      return current;
    }
    current = (candidate as { parentElement?: EngineElement | null }).parentElement ?? null;
  }
  return null;
}

function decodeBingRedirectTarget(url: URL): string {
  const encodedTarget = url.searchParams.get('u')?.trim();
  if (!encodedTarget) {
    return '';
  }
  // Bing's `u` parameter is base64url-encoded (`-`/`_` instead of `+`/`/`,
  // no padding), optionally prefixed with `a1`.
  const base64Payload = encodedTarget.startsWith('a1') ? encodedTarget.slice(2) : encodedTarget;
  try {
    const decodedTarget = Buffer.from(base64Payload, 'base64url').toString('utf8').trim();
    if (decodedTarget.startsWith('http://') || decodedTarget.startsWith('https://')) {
      return decodedTarget;
    }
  } catch {
    return '';
  }
  return '';
}

function sanitizeBingUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) {
    return '';
  }
  let resolvedUrl = rawUrl.trim();
  if (!resolvedUrl) {
    return '';
  }
  if (resolvedUrl.startsWith('//')) {
    resolvedUrl = `https:${resolvedUrl}`;
  } else if (resolvedUrl.startsWith('/')) {
    // Relative jump paths are Bing-internal redirects, not real result URLs;
    // a scheme-bearing `/ck/a` link is decoded from its `u` parameter below.
    if (resolvedUrl.startsWith('/search') || resolvedUrl.startsWith('/ck/a') || resolvedUrl.startsWith('/newtabredir')) {
      return '';
    }
    resolvedUrl = `https://cn.bing.com${resolvedUrl}`;
  }
  if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
    return '';
  }
  try {
    const url = new URL(resolvedUrl);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (hostname.endsWith('bing.com') && pathname.startsWith('/ck/a')) {
      const decodedTarget = decodeBingRedirectTarget(url);
      return decodedTarget ? sanitizeBingUrl(decodedTarget) : '';
    }
    if (
      hostname.endsWith('bing.com') &&
      (pathname.startsWith('/search') || pathname.startsWith('/ck/a') || pathname.startsWith('/newtabredir'))
    ) {
      return '';
    }
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach((param) => {
      url.searchParams.delete(param);
    });
    return url.toString();
  } catch {
    return '';
  }
}

function extractTitle(element: EngineElement | null, fallbackUrl: string, index: number): string {
  const candidateTitle = normalizeWhitespace(
    (element?.querySelector('h2 a')?.textContent ??
      element?.querySelector('.b_tpcn .tptt')?.textContent ??
      element?.querySelector('.b_title a')?.textContent ??
      element?.querySelector('a')?.textContent ??
      element?.querySelector('h2, h3, .b_title, .tptt')?.textContent) ||
      '',
  );
  if (candidateTitle) {
    return candidateTitle.slice(0, 200);
  }
  if (fallbackUrl) {
    try {
      return `Result from ${new URL(fallbackUrl).hostname}`;
    } catch {
      // invalid fallback URL, fall through to the generic label
    }
  }
  return normalizeWhitespace(element?.textContent ?? '').slice(0, 50) || `Result ${index + 1}`;
}

function extractDescription(element: EngineElement | null, title: string): string {
  const directSnippet = normalizeWhitespace(
    (element?.querySelector('.b_caption p')?.textContent ??
      element?.querySelector('.b_caption')?.textContent ??
      element?.querySelector('.b_snippet, .b_lineclamp2, .b_lineclamp3')?.textContent) ||
      '',
  );
  if (directSnippet) {
    return directSnippet.slice(0, 400);
  }
  const fallbackText = normalizeWhitespace(element?.textContent ?? '').replace(title, '').trim();
  return fallbackText.slice(0, 400);
}

function extractSource(element: EngineElement | null, url: string): string {
  const sourceText = normalizeWhitespace(
    (element?.querySelector('.b_tpcn')?.textContent ??
      element?.querySelector('.b_attribution cite')?.textContent ??
      element?.querySelector('cite')?.textContent) ||
      '',
  );
  if (sourceText) {
    return sourceText.slice(0, 200);
  }
  if (!url) {
    return '';
  }
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function collectFallbackLinks(
  $: (selector: string) => EngineQueryResult,
  limit: number,
  seenUrls: Set<string>,
  results: BingSearchResult[],
): void {
  const linkContainers = $('#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]');
  for (const [index, linkElement] of linkContainers.toArray().entries()) {
    if (results.length >= limit) {
      break;
    }
    const url = sanitizeBingUrl(
      (linkElement.getAttribute('href') ?? linkElement.getAttribute('redirecturl')) ??
        linkElement.getAttribute('data-h'),
    );
    if (!url || seenUrls.has(url)) {
      continue;
    }
    const container = closestElement(linkElement, 'li, .b_algo, .b_ans');
    const title = extractTitle(container, url, index);
    const description = extractDescription(container, title) || `Result from ${new URL(url).hostname}`;
    seenUrls.add(url);
    results.push({
      title,
      url,
      description,
      source: extractSource(container, url),
      engine: 'bing',
    });
  }
}

export function parseBingSearchResults(htmlContent: string, limit: number): BingSearchResult[] {
  const $ = loadHtml(htmlContent);
  const results: BingSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const selector of RESULT_SELECTORS) {
    for (const [index, node] of $(selector).toArray().entries()) {
      if (results.length >= limit) {
        break;
      }
      if (
        hasClass(node, 'b_ad') ||
        closestElement(node, '.b_ad') !== null ||
        hasClass(node, 'b_pag') ||
        hasClass(node, 'b_msg')
      ) {
        continue;
      }
      const titleLink = node.querySelector('h2 a, .b_title a, a.tilk, a[target="_blank"]');
      const url = sanitizeBingUrl(
        (titleLink?.getAttribute('href') ?? titleLink?.getAttribute('redirecturl')) ??
          titleLink?.getAttribute('data-h'),
      );
      if (!url || seenUrls.has(url)) {
        continue;
      }
      const title = extractTitle(node, url, index);
      const description = extractDescription(node, title);
      if (!title && !description) {
        continue;
      }
      seenUrls.add(url);
      results.push({
        title,
        url,
        description,
        source: extractSource(node, url),
        engine: 'bing',
      });
    }
    if (results.length >= limit) {
      break;
    }
  }
  if (results.length === 0) {
    collectFallbackLinks($, limit, seenUrls, results);
  }
  return results.slice(0, limit);
}
