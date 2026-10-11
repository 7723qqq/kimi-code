/**
 * Shared i18n types — used by all apps (Node.js and browser).
 *
 * The `TranslationKey<T>` type derives all valid dot-separated key paths from
 * a locale message tree, giving compile-time safety to `t()` calls.
 */

// ── Locale ───────────────────────────────────────────────────────────────────

export type Locale = 'en' | 'zh';

/**
 * Display names for each supported locale, written in that locale's own
 * language ("English", "中文") — the convention every language switcher uses,
 * and the reason these are data rather than a second translation tree: a
 * switcher must be readable by someone who does not yet read the UI language.
 *
 * `short` is the compact form for a toolbar button; `switchTo` is the label for
 * the action itself ("Switch to 中文"), which the caller pairs with its own
 * `switchLanguage` copy.
 */
export interface LocaleMeta {
  readonly code: Locale;
  readonly label: string;
  readonly short: string;
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'zh', label: '中文', short: '中' },
];

export const DEFAULT_LOCALE: Locale = 'en';

export function localeMeta(locale: Locale): LocaleMeta {
  return LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0]!;
}

/** The other supported locale — the one a "switch language" control targets. */
export function otherLocale(locale: Locale): Locale {
  return locale === 'en' ? 'zh' : 'en';
}

// ── Message tree ─────────────────────────────────────────────────────────────

export type MessageValue = string | { [key: string]: MessageValue };

// ── Deep path derivation ─────────────────────────────────────────────────────
//
// Given a message tree like:
//   { common: { ok: 'OK', cancel: 'Cancel' } }
// produces the union:
//   'common' | 'common.ok' | 'common.cancel'

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}.${P}`
    : never
  : never;

type Paths<T> = T extends MessageValue
  ? T extends string
    ? never
    : {
        [K in keyof T]-?: K extends string | number ? Join<K, Paths<T[K]>> | K : never;
      }[keyof T]
  : never;

/**
 * Derive all valid translation key paths from a locale message tree.
 *
 * @example
 * const en = { common: { ok: 'OK' } } as const;
 * type Key = TranslationKey<typeof en>; // 'common' | 'common.ok'
 */
export type TranslationKey<T> = Paths<T>;

// ── I18n instance ────────────────────────────────────────────────────────────

export interface I18nInstance<M extends Record<Locale, MessageValue>> {
  /** Translate a key with optional `{{param}}` interpolation. */
  t: (
    key: TranslationKey<M['en']> | (string & {}),
    params?: Record<string, string | number>,
  ) => string;
  /** Set the current locale. */
  setLocale: (locale: Locale) => void;
  /** Get the current locale. */
  getLocale: () => Locale;
  /** Get the messages object. */
  getMessages: () => M;
}

// ── Helper: collect all leaf keys from a message tree ────────────────────────

export function collectLeafKeys(obj: MessageValue, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = (obj as Record<string, MessageValue>)[key];
    if (typeof value === 'object' && value !== null) {
      keys.push(...collectLeafKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}
