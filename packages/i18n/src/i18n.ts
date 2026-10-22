import { interpolate } from '@moonshot-ai/i18n-shared/core';
import { detectLocaleNode } from '@moonshot-ai/i18n-shared/detect';
import type {
  Locale,
  TranslationKey as SharedTranslationKey,
} from '@moonshot-ai/i18n-shared/types';

import { en } from './locales/en';
import { zh } from './locales/zh';

export type { Locale } from '@moonshot-ai/i18n-shared/types';

export type TranslationKey = SharedTranslationKey<typeof en>;

// ── Pre-computed flat lookup maps ───────────────────────────────────────────
// Converts nested message trees to flat Map<dotPath, string> at module init,
// turning O(depth) tree traversal into O(1) Map.get for the hot lookup path.

function flattenMessages(obj: object, prefix = ''): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      map.set(fullKey, value);
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of flattenMessages(value as object, fullKey)) {
        map.set(k, v);
      }
    }
  }
  return map;
}

const flatMessages: Record<Locale, Map<string, string>> = {
  en: flattenMessages(en),
  zh: flattenMessages(zh),
};

// ── Locale detection ────────────────────────────────────────────────────────

let currentLocale: Locale = detectLocaleNode();

export function setLocale(locale: Locale): void {
  if (locale === 'en' || locale === 'zh') {
    currentLocale = locale;
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export type Engine = 'js';

/**
 * Returns the translation engine in use. Always `'js'`: lookups run in-process
 * against the flat message maps.
 *
 * The former napi round-trip shipped the whole locale JSON (about 130 KB,
 * twice) across the boundary on every `t()` call — ~290 µs per call against
 * ~0.05 µs for this lookup. The engine emits translated strings on hot event
 * paths, so that bridge was pure main-thread cost; the trees already live in
 * JS. Kept as an API for compatibility.
 */
export function getEngine(): Engine {
  return 'js';
}

// ── In-process lookup (flat map) ────────────────────────────────────────────

function translatePure(key: string, params?: Record<string, string | number>): string {
  const message = flatMessages[currentLocale].get(key) ?? flatMessages.en.get(key);
  if (message === undefined) {
    return key;
  }
  return params ? interpolate(message, params) : message;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  return translatePure(key, params);
}
