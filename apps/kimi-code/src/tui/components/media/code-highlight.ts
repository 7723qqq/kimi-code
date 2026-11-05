/**
 * Shared syntax-highlighting helpers for code previews
 * (tool-call Write/Edit, approval-panel Write content, full-screen preview).
 *
 * cli-highlight runs a full grammar pass over its input, so highlighting a
 * several-thousand-line Write costs hundreds of milliseconds to over a second
 * on the main thread. A preview that did that on every repaint froze the whole
 * TUI, including the timer-driven spinner. Two rules keep callers out of it:
 *
 * - A preview draws only a handful of lines, so `highlightLinesWindow()` feeds
 *   cli-highlight just those lines and reports the exact total line count for
 *   hints and line numbers.
 * - The full-document reader `highlightLines()` chunks the input and keeps a
 *   bounded LRU, so opening a large file is paid once instead of per frame, and
 *   at a fraction of the single-pass cost.
 */

import { extname } from 'node:path';

import { highlight, supportsLanguage } from 'cli-highlight';

import { codeHighlightTheme } from '#/tui/theme/highlight-theme';
import { currentTheme } from '#/tui/theme/theme';

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

/** Lines per cli-highlight pass on the full-document path. */
const FULL_FILE_CHUNK_LINES = 500;
/** Cache identity is the whole document; retention is bounded in both entries and characters. */
const CACHE_MAX_ENTRIES = 6;
const CACHE_MAX_CHARS = 2_000_000;

interface CacheEntry {
  readonly lines: string[];
  readonly chars: number;
}

const fullFileCache = new Map<string, CacheEntry>();
let cachedChars = 0;

export interface HighlightWindowResult {
  /** Highlighted lines in the requested window. Callers must not mutate them. */
  readonly lines: string[];
  /** Line count of the whole document, before windowing. */
  readonly totalLines: number;
}

export function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext.length === 0) return undefined;
  const lang = EXT_LANG_MAP[ext] ?? ext;
  return supportsLanguage(lang) ? lang : undefined;
}

/** Line count without paying for a grammar pass. */
export function codeLineCount(code: string): number {
  return code.split('\n').length;
}

function normalizedLanguage(lang: string | undefined): string | undefined {
  const normalized = lang?.trim().toLowerCase();
  return normalized !== undefined && normalized.length > 0 && supportsLanguage(normalized)
    ? normalized
    : undefined;
}

function highlightChunk(text: string, lang: string): string[] {
  try {
    return highlight(text, {
      language: lang,
      ignoreIllegals: true,
      theme: codeHighlightTheme,
    }).split('\n');
  } catch {
    return text.split('\n');
  }
}

/**
 * Highlight only `[start, start + count)` lines. The window is sliced before
 * cli-highlight sees the text, so cost depends on the window size, not on the
 * size of the file behind it.
 */
export function highlightLinesWindow(
  code: string,
  lang: string | undefined,
  start: number,
  count: number,
): HighlightWindowResult {
  const all = code.split('\n');
  const from = Math.max(0, Math.min(start, all.length));
  const to = Math.min(all.length, from + Math.max(0, count));
  const window = all.slice(from, to);
  const language = normalizedLanguage(lang);
  return {
    lines: language === undefined ? window : highlightChunk(window.join('\n'), language),
    totalLines: all.length,
  };
}

/**
 * Highlight the whole document. Chunking keeps one giant grammar pass from
 * monopolising the event loop; the LRU keeps repeat renders O(1).
 *
 * Cache contract: identity is language + theme diff colours + content hash +
 * length; the incremental unit is the whole document; a theme change produces a
 * new identity and `clearHighlightCache()` drops everything explicitly;
 * retention is the newest six entries within two million characters.
 */
export function highlightLines(code: string, lang: string | undefined): string[] {
  const language = normalizedLanguage(lang);
  if (language === undefined) return code.split('\n');

  const key = [
    language,
    currentTheme.color('diffAdded'),
    currentTheme.color('diffRemoved'),
    code.length,
    Bun.hash(code),
  ].join(':');
  const cached = fullFileCache.get(key);
  if (cached !== undefined) {
    fullFileCache.delete(key);
    fullFileCache.set(key, cached);
    return cached.lines;
  }

  const all = code.split('\n');
  const lines: string[] = [];
  for (let start = 0; start < all.length; start += FULL_FILE_CHUNK_LINES) {
    const chunk = all.slice(start, start + FULL_FILE_CHUNK_LINES).join('\n');
    lines.push(...highlightChunk(chunk, language));
  }
  remember(key, lines);
  return lines;
}

/** Drop cached full-document renderings (theme switches, tests). */
export function clearHighlightCache(): void {
  fullFileCache.clear();
  cachedChars = 0;
}

function remember(key: string, lines: string[]): void {
  const chars = lines.reduce((total, line) => total + line.length, 0);
  if (chars > CACHE_MAX_CHARS) return;
  fullFileCache.delete(key);
  fullFileCache.set(key, { lines, chars });
  cachedChars += chars;
  while (fullFileCache.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
    const oldest = fullFileCache.keys().next();
    if (oldest.done) break;
    const evicted = fullFileCache.get(oldest.value);
    if (evicted === undefined) break;
    fullFileCache.delete(oldest.value);
    cachedChars -= evicted.chars;
  }
}
