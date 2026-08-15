/**
 * `auth` domain (cross-cutting) — Sogou SERP parser, ported from the
 * open-websearch project (`engines/sogou/sogou.js`). Extracts organic
 * results from Sogou result pages through the linkedom shim (`loadHtml`):
 * layered result selectors, jump-link URL decoding (`url` / `u` / `link`
 * query parameters), source extraction, and URL dedup.
 */

import { loadHtml } from '../engine-html';

export interface SogouSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'sogou';
}

const SOGOU_SEARCH_URL = 'https://www.sogou.com/web';

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

export function isSogouChallengePage(html: string): boolean {
  const normalized = html.toLowerCase();
  const $ = loadHtml(html);
  const title = $('title').first().text().trim();
  return (
    normalized.includes('antispider') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('访问过于频繁') ||
    title.includes('搜狗搜索验证')
  );
}

export function resolveResultUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const absoluteUrl = new URL(trimmed, SOGOU_SEARCH_URL).toString();
    const parsed = new URL(absoluteUrl);
    const target =
      parsed.searchParams.get('url') ??
      parsed.searchParams.get('u') ??
      parsed.searchParams.get('link');
    if (target && /^https?:\/\//i.test(target)) {
      return target;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return absoluteUrl;
    }
  } catch {
    return '';
  }
  return '';
}

export function extractSource(url: string, sourceText: string): string {
  const cleanedSource = normalizeText(sourceText);
  if (cleanedSource) {
    return cleanedSource;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function parseSogouSearchResults(html: string): SogouSearchResult[] {
  const $ = loadHtml(html);
  const results: SogouSearchResult[] = [];
  const seenUrls = new Set<string>();
  const resultSelectors = [
    '#main .vrwrap',
    '#main .rb',
    '#main .result',
    '#results .vrwrap',
    '.results .vrwrap',
    '.results .rb',
  ].join(',');
  $(resultSelectors).each((_, element) => {
    const titleLink = element.querySelector(
      'h3 a[href], h2 a[href], .vr-title a[href], .pt a[href]',
    );
    const rawUrl = titleLink?.getAttribute('href') ?? '';
    const url = resolveResultUrl(rawUrl);
    const title = normalizeText(titleLink?.textContent ?? '');
    if (!title || !url || seenUrls.has(url)) {
      return;
    }
    const description = normalizeText(
      element.querySelector('.str_info, .ft, .text-layout, .fz-mid, p')?.textContent ?? '',
    );
    const source = extractSource(
      url,
      element.querySelector('cite, .citeurl, .g, .url')?.textContent ?? '',
    );
    seenUrls.add(url);
    results.push({
      title,
      url,
      description,
      source,
      engine: 'sogou',
    });
  });
  return results;
}
