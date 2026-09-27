/**
 * kimi-code i18n — backed by the compiled Rust translation engine.
 *
 * `t()` sends a key across napi; the engine resolves it against the locale
 * catalog it has compiled in, so `t()` itself ships no message trees. The
 * process-wide locale is named once via `setEngineLocale`.
 *
 * The locale is module-level state, the same way the engine's is: there is no
 * instance factory, so nothing can hold a second handle onto the language and
 * disagree with the strings the engine has already rendered.
 */

import { createRequire } from 'node:module';

import type { en } from '@moonshot-ai/i18n-catalog';
import { detectLocaleNode } from '@moonshot-ai/i18n-shared';
import type { Locale, TranslationKey as SharedTranslationKey } from '@moonshot-ai/i18n-shared';

const require = createRequire(import.meta.url);

// Re-export shared types for consumers.
export type { Locale };
export type TranslationKey = SharedTranslationKey<typeof en>;

// In the compiled Bun binary, @moonshot-ai/kimi-agent is excluded
// from the JS bundle and shipped as an embedded asset. When the direct
// require() fails there, ensureNative() falls back to loading the module
// from the native asset cache via getNativePackageRoot.
import { getNativePackageRoot } from '../native/native-assets';

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

function ensureNative(): NativeModule {
  if (nativeModule) return nativeModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const mod = require('@moonshot-ai/kimi-agent/native') as NativeModule;
    nativeModule = mod;
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

// ── Module-level state ───────────────────────────────────────────────────────

let currentLocale: Locale = detectLocaleNode();

// Whether the engine has been handed a locale yet. Flipped on the first `t()`
// so the install stays lazy — `ensureNative()` must not run at module load,
// before the locale the user actually chose is known.
let engineLocaleInstalled = false;

/**
 * Name the current locale for the engine's embedded catalog — the path the
 * napi `translate` binding reads, i.e. what `t()` resolves against. See
 * `packages/kimi-agent/src/i18n.rs`.
 *
 * It also names the locale the engine's own user-facing text resolves against
 * — permission reasons, tool-result notes, ACP approval labels — so those
 * follow the language the user selected rather than staying English.
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

// ── Public API ───────────────────────────────────────────────────────────────

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  const native = ensureNative();

  if (!engineLocaleInstalled) {
    engineLocaleInstalled = true;
    syncEngineLocale(currentLocale);
  }

  return native.translate(key, toNativeParams(params));
}

export function setLocale(locale: Locale): void {
  if (locale !== 'en' && locale !== 'zh') return;
  currentLocale = locale;
  // Re-point the engine at the new locale in the same breath, so a message
  // the engine produces mid-turn cannot come out in the language the user
  // just switched away from.
  syncEngineLocale(locale);
}

export function getLocale(): Locale {
  return currentLocale;
}
