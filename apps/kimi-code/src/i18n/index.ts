/**
 * kimi-code i18n — backed by the compiled Rust translation engine.
 *
 * `t()` sends a key across napi; the engine resolves it against the locale
 * catalog it has compiled in, so `t()` itself ships no message trees. The
 * process-wide locale is named once via `setEngineLocale`.
 *
 * `createI18n()` is a second handle onto the same process-wide engine locale,
 * not an isolated instance. Each keeps its own `currentLocale`, but `t()`
 * resolves against whatever locale was last handed to `setEngineLocale`, so two
 * instances on different locales cross-talk and render the wrong language
 * without error. Use the module-level singleton below; only that one is safe
 * today.
 *
 * `translateBatch` still hands trees over (`nativeTranslateBatch*`), which is
 * the pre-migration contract; it goes away with this file's remaining surface.
 *
 * Provides a module-level singleton (backward-compatible `t`, `setLocale`,
 * `getLocale`), plus batch translation via `translateBatch`.
 */

import { createRequire } from 'node:module';

import { en, zh } from '@moonshot-ai/i18n-catalog';
import type {
  Locale,
  TranslationKey as SharedTranslationKey,
  I18nInstance as SharedI18nInstance,
} from '@moonshot-ai/i18n-shared';
import { detectLocaleNode } from '@moonshot-ai/i18n-shared';

const require = createRequire(import.meta.url);

// Re-export shared types for consumers.
export type { Locale };
export type TranslationKey = SharedTranslationKey<typeof en>;
export type Engine = 'rust' | 'js';

// In the compiled Bun binary, @moonshot-ai/kimi-agent is excluded
// from the JS bundle and shipped as an embedded asset. When the direct
// require() fails there, ensureNative() falls back to loading the module
// from the native asset cache via getNativePackageRoot.
import { getNativePackageRoot } from '../native/native-assets';

const messages = { en, zh } as const;

// ── I18nInstance with batch support ────────────────────────────────────────────

export interface I18nInstance extends SharedI18nInstance<typeof messages> {
  /**
   * Returns whether the native Rust engine is active.
   * Always `'rust'` in kimi-code — the engine throws if unavailable.
   */
  getEngine: () => Engine;

  /**
   * Translate multiple keys in a single native call, parsing the JSON only once.
   *
   * Falls back to the cached engine when available. If neither batch variant is
   * available in the native module, iterates individual `t()` calls as a last
   * resort.
   */
  translateBatch: (
    keys: string[],
    params?: Record<string, string | number>,
  ) => { key: string; message: string }[];
}

// ── Native Rust engine (compiled, no fallback) ────────────────────────────────
// The Rust module is compiled into the binary via napi-rs. If it's not available
// the error is thrown immediately — no silent fallback, because the compiled
// engine is the only canonical implementation.

interface NativeModule {
  /**
   * Resolve `key` against the engine's embedded catalog, interpolating
   * `params`. Returns the key itself when it is in neither locale.
   */
  translate: (key: string, params: Record<string, string> | null | undefined) => string;
  nativeTranslateClearCache?: () => void;
  nativeTranslateBatch?: (
    localeJson: string,
    fallbackJson: string,
    keys: string[],
    params: Record<string, string> | null | undefined,
  ) => { key: string; message: string }[];
  nativeTranslateBatchCached?: (
    localeJson: string,
    fallbackJson: string,
    keys: string[],
    params: Record<string, string> | null | undefined,
  ) => { key: string; message: string }[];
  /**
   * Name the engine's active locale. The catalog is compiled into the binary,
   * so this carries a locale name, not the message trees the host used to push.
   *
   * Optional because an older native build lacks the binding — but there is no
   * JavaScript fallback behind `t()`, so a missing one leaves every string
   * English while `getLocale()` still reports the requested locale.
   */
  setEngineLocale?: (locale: string) => void;
}

let nativeModule: NativeModule | undefined;
let localeJsonEn: string | undefined;

function ensureNative(): NativeModule {
  if (nativeModule) return nativeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const mod = require('@moonshot-ai/kimi-agent/native') as NativeModule;
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
    return mod;
  } catch {
    // In the compiled binary the module is an embedded asset, not a bundled JS module.
    // Load it from the extracted cache via getNativePackageRoot.
    const pkgRoot = getNativePackageRoot('@moonshot-ai/kimi-agent');
    if (pkgRoot === null)
      throw new Error(
        'Failed to load @moonshot-ai/kimi-agent/native: not available as a bundled module or native asset.',
      );
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const cacheRequire = createRequire(join(pkgRoot, 'index.js'));
    const mod = cacheRequire(join(pkgRoot, 'index.js')) as NativeModule;
    nativeModule = mod;
    localeJsonEn = JSON.stringify(en);
    return mod;
  }
}

function toNativeParams(
  params?: Record<string, string | number>,
): Record<string, string> | undefined {
  return params
    ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    : undefined;
}

/**
 * Name the current locale for the engine's embedded catalog — the path the
 * napi `translate` binding reads, i.e. what `t()` resolves against. See
 * `packages/kimi-agent/src/i18n.rs`.
 *
 * It does not reach the engine's own messages: those still render their
 * carried English, because `LocalizedText` resolves through a tree-injecting
 * seam no napi binding exposes.
 *
 * Best-effort by design: an older build without the binding leaves `t()`
 * rendering English for every key while `getLocale()` still reports the
 * requested locale, rather than failing the host. A missing native module is
 * not best-effort — `t()` throws on its own.
 */
function syncEngineLocale(locale: string): void {
  try {
    ensureNative().setEngineLocale?.(locale);
  } catch {
    /* nothing to name: a missing native module makes `t()` throw on its own */
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface CreateI18nOptions {
  /** Initial locale. Defaults to env-based detection. */
  initialLocale?: Locale;
  /** Skip auto-detection even in Node.js. */
  noDetect?: boolean;
}

/**
 * Create an i18n instance backed by the Rust translation engine.
 *
 * Not isolated from any other instance: `t()` resolves against the process-wide
 * engine locale, so a second instance on a different locale silently overrides
 * the first. See the module header.
 *
 * @example
 * const { t, setLocale } = createI18n();
 * console.log(t('cli.errors.promptEmpty'));
 */
export function createI18n(options: CreateI18nOptions = {}): I18nInstance {
  // An explicit initialLocale always wins; noDetect only suppresses
  // env-based detection (falling back to 'en') when no locale was given.
  let currentLocale: Locale =
    options.initialLocale ?? (options.noDetect ? 'en' : detectLocaleNode());

  // `translateBatch` still hands the engine the raw trees; `t()` does not.
  let localeCurrentJson = JSON.stringify(messages[currentLocale]);
  // The engine only needs its locale once, but `createI18n()` runs at module
  // load — before we know a native module is even present — so the first
  // `t()` performs the install instead. `setLocale()` re-installs on every
  // switch, which also covers the common path where the app sets an explicit
  // locale at startup.
  let engineLocaleInstalled = false;

  return {
    t(key: TranslationKey | (string & {}), params?: Record<string, string | number>): string {
      const native = ensureNative();
      const stringParams = toNativeParams(params);

      if (!engineLocaleInstalled) {
        engineLocaleInstalled = true;
        syncEngineLocale(currentLocale);
      }

      return native.translate(key, stringParams);
    },

    setLocale(locale: Locale): void {
      if (locale in messages) {
        currentLocale = locale;
        localeCurrentJson = JSON.stringify(messages[locale]);
        try {
          const native = ensureNative();
          native.nativeTranslateClearCache?.();
          // Re-point the engine at the new locale in the same breath, so a
          // message the engine produces mid-turn cannot come out in the
          // language the user just switched away from.
          native.setEngineLocale?.(currentLocale);
        } catch {
          /* native module may not be loaded yet */
        }
      }
    },

    getLocale(): Locale {
      return currentLocale;
    },

    getEngine(): Engine {
      return 'rust';
    },

    getMessages(): typeof messages {
      return messages;
    },

    translateBatch(
      keys: string[],
      params?: Record<string, string | number>,
    ): { key: string; message: string }[] {
      const native = ensureNative();
      const stringParams = toNativeParams(params);

      // Prefer cached batch, fall back to uncached batch.
      if (native.nativeTranslateBatchCached) {
        return native.nativeTranslateBatchCached(
          localeCurrentJson,
          localeJsonEn!,
          keys,
          stringParams,
        );
      }
      if (native.nativeTranslateBatch) {
        return native.nativeTranslateBatch(localeCurrentJson, localeJsonEn!, keys, stringParams);
      }
      // Last-resort: translate each key individually.
      return keys.map((key) => ({
        key,
        message: this.t(key, params),
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
