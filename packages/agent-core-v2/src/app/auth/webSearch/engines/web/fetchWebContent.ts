import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import { Error2, ErrorCodes } from '#/errors';

import { isBlockedIpAddress } from '#/_base/utils/private-address';

import { loadHtml, type EngineElement } from '../engine-html';
import { debugLog, engineFetch, type EngineHttpResponse } from '../engine-http';
import type { SearchEngineOptions } from '../types';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 30_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 200_000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

const FALLBACK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Accept:
    'text/markdown,text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

interface DomElementLike {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElementLike | null;
  querySelectorAll(selector: string): readonly DomElementLike[];
  body: DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

export interface FetchWebContentOptions extends SearchEngineOptions {
  /** Maximum characters to keep; clamped to 1 000–200 000. */
  maxChars?: number;
  /** Run the `@mozilla/readability` article parser when the response is HTML. */
  readability?: boolean;
  /** With `readability`, also extract links from the parsed article. */
  includeLinks?: boolean;
}

export interface FetchWebContentLink {
  text: string;
  href: string;
}

export interface FetchWebContentResult {
  url: string;
  finalUrl: string;
  contentType: string;
  title?: string;
  retrievalMethod: string;
  truncated: boolean;
  content: string;
  readabilityApplied?: boolean;
  readableHtml?: string;
  links?: FetchWebContentLink[];
  byline?: string;
  excerpt?: string;
  siteName?: string;
}

function normalizeText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[ \t]+\n/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function clampMaxChars(value: number): number {
  return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, value));
}

function looksLikeHtml(raw: string): boolean {
  return /<!doctype html|<html[\s>]|<body[\s>]/i.test(raw);
}

function isMarkdownPath(url: URL): boolean {
  const pathname = url.pathname.toLowerCase();
  return pathname.endsWith('.md') || pathname.endsWith('.markdown') || pathname.endsWith('.mdx');
}

function logReadabilityFallback(message: string, error?: unknown): void {
  if (error instanceof Error) {
    debugLog(`[fetchWebContent/readability] ${message}: ${error.message}`);
    return;
  }
  debugLog(`[fetchWebContent/readability] ${message}`);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

function removeAll($: ReturnType<typeof loadHtml>, selector: string): void {
  for (const element of $(selector).toArray()) {
    (element as EngineElement & { remove(): void }).remove();
  }
}

function extractMainTextFromHtml(html: string): { title: string; text: string; mode: string } {
  const $ = loadHtml(html);
  const title = $('title').first().text().trim();
  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() ??
    $('meta[property="og:description"]').attr('content')?.trim() ??
    '';
  removeAll($, 'script, style, noscript, template, iframe, svg, canvas');
  const preferredContainers = [
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.content',
  ];
  let selectedText = '';
  let mode = 'metadata';
  for (const selector of preferredContainers) {
    const container = $(selector).first();
    if (container.length === 0) {
      continue;
    }
    const candidate = normalizeText(container.text());
    if (candidate.length >= 120) {
      selectedText = candidate;
      mode = 'container';
      break;
    }
  }
  if (selectedText === '') {
    const body = $('body');
    selectedText = body.length > 0 ? normalizeText(body.text()) : '';
    if (selectedText !== '') {
      mode = 'body';
    }
  }
  if (selectedText === '') {
    selectedText = normalizeText([title, metaDescription].filter(Boolean).join('\n\n'));
    mode = 'metadata';
  }
  return { title, text: selectedText, mode };
}

function extractReadableTextFromHtml(html: string): string {
  const { document } = parseHTML(html);
  return normalizeText(document.body?.textContent ?? '');
}

function extractReadableLinks(html: string, finalUrl: string): FetchWebContentLink[] {
  const { document } = parseHTML(html);
  const anchors = document.querySelectorAll('a[href]');
  const seen = new Set<string>();
  const links: FetchWebContentLink[] = [];
  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href');
    if (rawHref === null) {
      continue;
    }
    let href: string;
    try {
      href = new URL(rawHref, finalUrl).toString();
      assertPublicHttpUrl(href, 'Extracted link URL');
    } catch {
      continue;
    }
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    links.push({
      text: normalizeText(anchor.textContent ?? ''),
      href,
    });
  }
  return links;
}

function assertPublicHttpUrl(url: string | URL, label = 'URL'): URL {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `${label} must use HTTP or HTTPS.`, {
      details: { url: parsed.toString(), protocol: parsed.protocol },
    });
  }
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  if (isIP(host) !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `${label} points to a private or local network target.`,
        {
          details: { url: parsed.toString(), host },
        },
      );
    }
    return parsed;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `${label} points to a private or local network target.`,
      {
        details: { url: parsed.toString(), host },
      },
    );
  }
  return parsed;
}

async function assertPublicHttpUrlResolved(url: string | URL, label = 'URL'): Promise<void> {
  const parsed = assertPublicHttpUrl(url, label);
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  if (isIP(host) !== 0) {
    return;
  }
  let addresses: readonly LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `${label} could not be resolved: ${detail}`, {
      cause: error,
      details: { url: parsed.toString(), host },
    });
  }
  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `${label} resolves to a private or local network target.`,
        { details: { url: parsed.toString(), host, address: entry.address } },
      );
    }
  }
}

interface SafeFetchResponse {
  response: EngineHttpResponse;
  finalUrl: string;
}

async function requestWithSafeRedirects(
  method: 'GET',
  url: string,
  options: SearchEngineOptions,
  urlLabel: string,
): Promise<SafeFetchResponse> {
  let currentUrl = url;
  for (let hops = 0; hops <= MAX_REDIRECT_HOPS; hops += 1) {
    await assertPublicHttpUrlResolved(currentUrl, hops === 0 ? urlLabel : 'Redirect target');
    let response: EngineHttpResponse;
    try {
      if (options.fetchImpl !== undefined) {
        const native = await options.fetchImpl(currentUrl, {
          method,
          headers: FALLBACK_HEADERS,
          signal: options.signal,
          redirect: 'manual',
        });
        response = {
          ok: native.ok,
          status: native.status,
          statusText: native.statusText,
          text: () => native.text(),
          stream: () => native.body,
          header: (name: string) => native.headers.get(name),
        };
      } else {
        if (options.signal?.aborted === true) {
          const abortError = new Error('The operation was aborted.');
          abortError.name = 'AbortError';
          throw abortError;
        }
        response = await engineFetch(currentUrl, {
          method,
          headers: FALLBACK_HEADERS,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          manualRedirect: true,
        });
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Request to ${currentUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.header('location');
      if (location !== null) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        `Request failed: HTTP ${String(response.status)}.`,
        {
          details: { status: response.status, url: currentUrl },
        },
      );
    }
    return { response, finalUrl: currentUrl };
  }
  throw new Error2(
    ErrorCodes.WEB_FETCH_FAILED,
    `Too many redirects (max ${String(MAX_REDIRECT_HOPS)})`,
    {
      details: { url },
    },
  );
}

function tooLargeError(bytes: number): Error2 {
  return new Error2(
    ErrorCodes.WEB_FETCH_FAILED,
    `Response body too large (${String(bytes)} bytes). Max allowed is ${String(MAX_DOWNLOAD_BYTES)} bytes`,
    { details: { bytes, maxBytes: MAX_DOWNLOAD_BYTES } },
  );
}

async function readBodyWithLimit(response: EngineHttpResponse): Promise<string> {
  const body = response.stream();
  if (body === null) {
    const raw = await response.text();
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_DOWNLOAD_BYTES) {
      throw tooLargeError(bytes);
    }
    return raw;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw tooLargeError(total);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchWebContent(
  url: string,
  options: FetchWebContentOptions = {},
): Promise<FetchWebContentResult | undefined> {
  const parsedUrl = new URL(url);
  const maxChars = clampMaxChars(options.maxChars ?? DEFAULT_MAX_CHARS);

  const { response, finalUrl } = await requestWithSafeRedirects(
    'GET',
    parsedUrl.toString(),
    options,
    'Request URL',
  );
  const contentType = response.header('content-type') ?? '';
  const contentLengthRaw = response.header('content-length');
  if (contentLengthRaw !== null) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw tooLargeError(contentLength);
    }
  }

  let raw = await readBodyWithLimit(response);
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOWNLOAD_BYTES) {
    throw tooLargeError(Buffer.byteLength(raw, 'utf8'));
  }

  const finalParsedUrl = new URL(finalUrl);
  const lowerContentType = contentType.toLowerCase();
  let title = '';
  let extractedContent = '';
  let htmlExtraction: { title: string; text: string; mode: string } | undefined;
  let readabilityApplied = false;
  let readableHtml: string | undefined;
  let links: FetchWebContentLink[] | undefined;
  let byline: string | undefined;
  let excerpt: string | undefined;
  let siteName: string | undefined;

  if (isMarkdownPath(finalParsedUrl)) {
    extractedContent = normalizeText(raw);
  } else if (lowerContentType.includes('text/html') || looksLikeHtml(raw)) {
    htmlExtraction = extractMainTextFromHtml(raw);
    title = htmlExtraction.title;
    extractedContent = htmlExtraction.text;
  } else {
    extractedContent = normalizeText(raw);
  }

  if (
    options.readability === true &&
    (lowerContentType.includes('text/html') || looksLikeHtml(raw))
  ) {
    try {
      const { document } = parseHTML(raw);
      const article = new Readability(document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      }).parse();
      const articleContent = article?.content;
      if (article !== null && articleContent !== null && articleContent !== undefined) {
        const readableText = normalizeText(
          article.textContent ?? extractReadableTextFromHtml(articleContent),
        );
        if (readableText !== '') {
          readabilityApplied = true;
          readableHtml = articleContent;
          links =
            options.includeLinks === true
              ? extractReadableLinks(articleContent, finalUrl)
              : undefined;
          byline = article.byline?.trim() ?? undefined;
          excerpt = article.excerpt?.trim() ?? undefined;
          siteName = article.siteName?.trim() ?? undefined;
          title = article.title?.trim() ?? title;
          extractedContent = readableText;
        }
      } else {
        logReadabilityFallback('parser returned no article content');
      }
    } catch (error) {
      logReadabilityFallback('falling back to existing extractor after parser error', error);
    }
  }

  if (extractedContent === '') {
    return undefined;
  }

  const truncated = extractedContent.length > maxChars;
  const content = truncated
    ? `${extractedContent.slice(0, maxChars)}\n\n[...truncated ${String(extractedContent.length - maxChars)} characters]`
    : extractedContent;

  return {
    url: parsedUrl.toString(),
    finalUrl,
    contentType: lowerContentType || 'unknown',
    title: title || undefined,
    retrievalMethod: 'request',
    truncated,
    content,
    ...(readabilityApplied ? { readabilityApplied } : {}),
    ...(readableHtml !== undefined ? { readableHtml } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(byline !== undefined ? { byline } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(siteName !== undefined ? { siteName } : {}),
  };
}
