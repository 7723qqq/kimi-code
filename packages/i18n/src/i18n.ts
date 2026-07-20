export type Locale = 'en' | 'zh';

type MessageValue = string | { [key: string]: MessageValue };

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}.${P}`
    : never
  : never;

type Paths<T> = T extends MessageValue
  ? T extends string
    ? never
    : {
        [K in keyof T]-?: K extends string | number
          ? Join<K, Paths<T[K]>> | K
          : never;
      }[keyof T]
  : never;

export type TranslationKey = Paths<typeof import('./locales/en').default>;

import { en } from './locales/en';
import { zh } from './locales/zh';

const messages: Record<Locale, object> = { en, zh };

// ── Optional native Rust engine ─────────────────────────────────────────────
// The Rust engine (`@moonshot-ai/kimi-native-tools`) provides a faster path
// via napi-rs. When unavailable (e.g. in a browser or SEA binary), we fall
// back to the pure-JS implementation transparently.

interface NativeModule {
  nativeTranslateCached?: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
  nativeTranslate: (
    localeJson: string,
    fallbackJson: string,
    key: string,
    params: Record<string, string> | null | undefined,
  ) => string;
  nativeTranslateClearCache?: () => void;
}

let nativeModule: NativeModule | null | undefined;
let localeJsonEn: string | undefined;

function tryLoadNative(): NativeModule | null {
  if (nativeModule !== undefined) return nativeModule;
  // Allow forcing the pure-JS fallback via environment variable (for testing).
  if (process.env['KIMI_I18N_FORCE_JS']) {
    nativeModule = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@moonshot-ai/kimi-native-tools') as NativeModule;
    // Verify the module actually has translation functions.
    if (typeof mod.nativeTranslateCached !== 'function' && typeof mod.nativeTranslate !== 'function') {
      nativeModule = null;
      return null;
    }
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
    return mod;
  } catch {
    nativeModule = null;
    return null;
  }
}

// ── Locale detection ────────────────────────────────────────────────────────

let currentLocale: Locale;

function detectLocale(): Locale {
  const envLang = process.env['KIMI_LANG'];
  if (envLang === 'zh' || envLang?.startsWith('zh')) {
    return 'zh';
  }
  if (envLang === 'en' || envLang?.startsWith('en')) {
    return 'en';
  }
  return 'en';
}

currentLocale = detectLocale();

// Serialized JSON for the current locale (used by the native engine, lazily
// computed so locale switching doesn't force serialization until first use).
let localeJsonCurrent: string | undefined;

export function setLocale(locale: Locale): void {
  if (locale in messages) {
    currentLocale = locale;
    localeJsonCurrent = undefined; // re-serialize lazily on next t() call
    // Invalidate the Rust-side cache so stale parsed JSON is evicted.
    const native = tryLoadNative();
    native?.nativeTranslateClearCache?.();
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export type Engine = 'rust' | 'js';

/**
 * Returns whether the native Rust engine is active, or the pure-JS fallback.
 *
 * - `'rust'` — `@moonshot-ai/kimi-native-tools` napi module loaded successfully
 * - `'js'`   — napi module unavailable, using pure-JS translation
 */
export function getEngine(): Engine {
  return tryLoadNative() ? 'rust' : 'js';
}

// ── Pure-JS fallback ────────────────────────────────────────────────────────

function resolveMessage(locale: Locale, key: string): string | undefined {
  const parts = key.split('.');
  let current: MessageValue | undefined = messages[locale] as MessageValue;
  for (const part of parts) {
    if (current === undefined || typeof current === 'string') {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolatePure(message: string, params: Record<string, string | number>): string {
  return message.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const value = params[name];
    return value !== undefined ? String(value) : `{{${name}}}`;
  });
}

function translatePure(key: string, params?: Record<string, string | number>): string {
  let message = resolveMessage(currentLocale, key);
  if (message === undefined) {
    message = resolveMessage('en', key);
  }
  if (message === undefined) {
    return key;
  }
  return params ? interpolatePure(message, params) : message;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  const native = tryLoadNative();
  if (native) {
    // Use the Rust native engine.
    if (localeJsonCurrent === undefined) {
      localeJsonCurrent = JSON.stringify(messages[currentLocale]);
    }
    const stringParams: Record<string, string> | undefined = params
      ? Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        )
      : undefined;

    if (native.nativeTranslateCached) {
      return native.nativeTranslateCached(
        localeJsonCurrent!,
        localeJsonEn!,
        key,
        stringParams,
      );
    }
    return native.nativeTranslate(
      localeJsonCurrent!,
      localeJsonEn!,
      key,
      stringParams,
    );
  }

  // Fall back to pure-JS implementation.
  return translatePure(key, params);
}