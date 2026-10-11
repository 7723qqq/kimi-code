/**
 * Locale detection — shared by all apps.
 *
 * Two strategies:
 * - `detectLocaleNode()`: checks `KIMI_LANG`, `LANG`, `LC_ALL`, `LC_MESSAGES` env vars.
 * - `detectLocaleWeb()`: checks `localStorage`, then `navigator.language`.
 *
 * Both fall back to `'en'` when no match is found.
 */

import type { Locale } from './types.js';

/**
 * Check whether a language string represents Chinese.
 * Accepts `zh`, `zh-CN`, `zh_TW`, `zh-Hant`, … — the language subtag must be
 * exactly `zh`, so unrelated tags such as `zho` are not swept in by a prefix
 * match, and a modifier like `zhx` does not either.
 */
function isZh(lang: string | undefined | null): boolean {
  if (!lang) return false;
  return languageSubtag(lang) === 'zh';
}

/**
 * Check whether a language string represents English.
 * Accepts `en`, `en-US`, `en_GB`, … but not `enm` or other `en`-prefixed tags.
 */
function isEn(lang: string | undefined | null): boolean {
  if (!lang) return false;
  return languageSubtag(lang) === 'en';
}

/** The primary language subtag of a BCP-47-ish tag, lowercased. */
function languageSubtag(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  const match = /^[a-z]+/.exec(normalized);
  return match?.[0] ?? '';
}

// ── Node.js detection ────────────────────────────────────────────────────────

/**
 * Detect locale from environment variables (Node.js).
 *
 * Priority: `KIMI_LANG` > `LANG` > `LC_ALL` > `LC_MESSAGES`.
 */
export function detectLocaleNode(): Locale {
  // Typed view of `globalThis.process` so this stays compilable in
  // browser-only TS configs without @types/node.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (!env) return 'en';

  const kimiLang = env['KIMI_LANG'];
  if (kimiLang === 'zh' || isZh(kimiLang)) return 'zh';
  if (kimiLang === 'en' || isEn(kimiLang)) return 'en';

  const systemLang = env['LANG'] ?? env['LC_ALL'] ?? env['LC_MESSAGES'];
  if (isZh(systemLang)) return 'zh';

  return 'en';
}

// ── Browser detection ────────────────────────────────────────────────────────

/**
 * Detect locale from `localStorage` and `navigator.language` (browser).
 *
 * @param storageKey - The localStorage key to check for a stored preference.
 */
export function detectLocaleWeb(storageKey?: string): Locale {
  // Check stored preference first
  if (storageKey) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'en' || stored === 'zh') return stored;
    } catch {
      /* localStorage may be unavailable (SSR, sandbox) */
    }
  }

  // Fall back to browser language
  if (typeof navigator !== 'undefined' && navigator.language) {
    if (isZh(navigator.language)) return 'zh';
  }

  return 'en';
}

// ── Universal detection ──────────────────────────────────────────────────────

/**
 * Auto-detect locale: uses Node.js env vars if available, otherwise browser APIs.
 *
 * @param storageKey - Optional localStorage key for browser stored preference.
 */
export function detectLocale(storageKey?: string): Locale {
  const nodeProcess = (globalThis as { process?: { env?: unknown } }).process;
  if (nodeProcess !== undefined && nodeProcess.env) {
    return detectLocaleNode();
  }
  return detectLocaleWeb(storageKey);
}
