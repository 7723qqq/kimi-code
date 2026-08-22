import { Error2, ErrorCodes } from '#/errors';

import { loadHtml, type EngineElement } from '../engine-html';

export interface StartpageSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'startpage';
}

const CAPTCHA_UI_SELECTORS = [
  'form[action*="/sp/captcha"]',
  'iframe[src*="captcha"]',
  '[id*="captcha"]',
  '[class*="captcha"]',
].join(',');

const VERIFICATION_KEYWORDS = ['verify you are human', 'human verification', 'security check'];

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

export function isCaptchaPage(html: string): boolean {
  const normalized = html.toLowerCase();
  const $ = loadHtml(html);
  const title = $('title').first().text().trim().toLowerCase();
  if (normalized.includes('/sp/captcha')) {
    return true;
  }
  const hasCaptchaUi = $(CAPTCHA_UI_SELECTORS).length > 0;
  const hasVerificationText = VERIFICATION_KEYWORDS.some(
    (keyword) => normalized.includes(keyword) || title.includes(keyword),
  );
  return hasCaptchaUi || hasVerificationText;
}

export function extractScCode(html: string): string | undefined {
  const $ = loadHtml(html);
  return $('form[action="/sp/search"] input[name="sc"]').first().attr('value')?.trim() ?? undefined;
}

export function extractInterstitialPayload(html: string): Record<string, string> | undefined {
  const match = html.match(/var data = (\{[\s\S]*?\});/);
  const payloadRaw = match?.[1];
  if (payloadRaw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(payloadRaw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    if (typeof payload['query'] !== 'string' || typeof payload['sgt'] !== 'string') {
      return undefined;
    }
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') {
        data[key] = value;
      }
    }
    return Object.keys(data).length > 0 ? data : undefined;
  } catch {
    return undefined;
  }
}

function firstMatchingNextSibling(element: EngineElement, selector: string): EngineElement | null {
  let sibling = (element as { nextElementSibling?: EngineElement | null }).nextElementSibling;
  while (sibling !== null && sibling !== undefined) {
    const matcher = sibling as EngineElement & { matches?: (selector: string) => boolean };
    if (matcher.matches !== undefined && matcher.matches(selector)) {
      return sibling;
    }
    sibling = (sibling as { nextElementSibling?: EngineElement | null }).nextElementSibling;
  }
  return null;
}

function extractSource(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function extractResultsFromHtml(html: string): StartpageSearchResult[] {
  if (isCaptchaPage(html)) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      'Startpage returned a verification or anti-bot page',
    );
  }
  const $ = loadHtml(html);
  const results: StartpageSearchResult[] = [];
  const seenUrls = new Set<string>();
  $('a.result-title.result-link[href]').each((_, element) => {
    const url = element.getAttribute('href')?.trim();
    const title = normalizeWhitespace(element.querySelector('h2')?.textContent ?? '');
    const descriptionElement = firstMatchingNextSibling(element, 'p.description');
    const description = normalizeWhitespace(descriptionElement?.textContent ?? '');
    if (url === undefined || url === '' || title === '' || seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);
    results.push({
      title,
      url,
      description,
      source: extractSource(url),
      engine: 'startpage',
    });
  });
  return results;
}
