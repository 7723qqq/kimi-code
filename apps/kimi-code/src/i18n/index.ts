/**
 * kimi-code i18n — pure in-process translation.
 *
 * Lookups run directly against the bundled `en`/`zh` message trees with
 * `@moonshot-ai/i18n-shared`'s `translate` (dot-key resolve -> fallback
 * locale -> the key itself, then `{{param}}` interpolation).
 *
 * Translation used to round-trip through the retired native module with the whole
 * locale JSON (about 130 KB, twice) on every `t()` call — ~290 µs per call
 * versus ~0.05 µs for an in-process lookup. The message trees already live in
 * JS, so the bridge added only main-thread cost on exactly the render-heavy
 * paths (tool cards, status lines, spinners) that call `t()` hundreds of times
 * a second. Lookups therefore stay in-process.
 *
 * Provides both a module-level singleton (backward-compatible `t`, `setLocale`,
 * `getLocale`) and a `createI18n()` factory for multi-instance use, plus batch
 * translation via `translateBatch`.
 */

import type {
  Locale,
  TranslationKey as SharedTranslationKey,
  I18nInstance as SharedI18nInstance,
} from '@moonshot-ai/i18n-shared';
import { detectLocaleNode, translate } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

// Re-export shared types for consumers.
export type { Locale };
export type TranslationKey = SharedTranslationKey<typeof en>;
/** Kept for API compatibility — translation is in-process, so always `'js'`. */
export type Engine = 'js';

const messages = { en, zh } as const;

// ── I18nInstance with batch support ────────────────────────────────────────────

export interface I18nInstance extends SharedI18nInstance<typeof messages> {
  /**
   * Returns the translation engine in use. Always `'js'` — lookups run
   * in-process (see the module doc for why the napi round-trip was dropped).
   */
  getEngine: () => Engine;

  /**
   * Translate multiple keys in one pass over the same message trees.
   */
  translateBatch: (
    keys: string[],
    params?: Record<string, string | number>,
  ) => { key: string; message: string }[];
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface CreateI18nOptions {
  /** Initial locale. Defaults to env-based detection. */
  initialLocale?: Locale;
  /** Skip auto-detection even in Node.js. */
  noDetect?: boolean;
}

/**
 * Create an i18n instance backed by the in-process message trees.
 *
 * @example
 * const { t, setLocale } = createI18n();
 * console.log(t('cli.errors.promptEmpty'));
 */
export function createI18n(options: CreateI18nOptions = {}): I18nInstance {
  // An explicit initialLocale always wins; noDetect only suppresses
  // detection (falling back to 'en') when no locale was given.
  let currentLocale: Locale =
    options.initialLocale ?? (options.noDetect ? 'en' : detectLocaleNode());

  return {
    t(key, params) {
      return translate(messages[currentLocale], messages.en, key, params);
    },

    setLocale(locale: Locale): void {
      if (locale in messages) {
        currentLocale = locale;
      }
    },

    getLocale(): Locale {
      return currentLocale;
    },

    getEngine(): Engine {
      return 'js';
    },

    getMessages(): typeof messages {
      return messages;
    },

    translateBatch(keys, params) {
      return keys.map((key) => ({
        key,
        message: translate(messages[currentLocale], messages.en, key, params),
      }));
    },
  };
}

// ── Module-level default singleton (backward-compatible API) ─────────────────

const defaultI18n = createI18n();

export const t = defaultI18n.t.bind(defaultI18n);
export const setLocale = defaultI18n.setLocale.bind(defaultI18n);
export const getLocale = defaultI18n.getLocale.bind(defaultI18n);
export const getEngine = defaultI18n.getEngine.bind(defaultI18n);
export const getMessages = defaultI18n.getMessages.bind(defaultI18n);
export const translateBatch = defaultI18n.translateBatch.bind(defaultI18n);
