/**
 * VS Code extension-host i18n.
 *
 * The webview (`webview-ui/src/i18n`) uses `createI18n` from
 * `@moonshot-ai/i18n-shared/web`, which detects the locale from
 * `localStorage` / `navigator.language`. The extension host has neither — it
 * is a Node process — so it detects from `vscode.env.language` instead, the
 * editor's own display language. Both therefore follow the user's system
 * language, and the two ends agree in every normal configuration.
 *
 * The host keeps its own catalog: its strings are extension-host messages
 * (command results, `show*Message` toasts, thrown errors) and share no keys
 * with the webview's UI vocabulary.
 *
 * Pure JS on purpose — the extension host must not depend on the napi engine,
 * which is only present in the packaged CLI binary.
 */

import type { Locale, TranslationKey as TranslationKeyOf } from '@moonshot-ai/i18n-shared';
import { translate } from '@moonshot-ai/i18n-shared';

import en from './locales/en';
import zh from './locales/zh';

export type { Locale };
export type TranslationKey = TranslationKeyOf<typeof en>;

const messages = { en, zh } as const;

/**
 * Resolved lazily, through a `require` rather than a top-level import.
 *
 * A top-level `import * as vscode` would make every test that transitively
 * reaches this module fail to load: `vscode` is injected by the editor at
 * runtime, so it only resolves under the extension host, and the suite mocks it
 * per test file (`vi.mock('vscode')`) — which cannot cover a module that was
 * not previously in the graph. `t()` is also reached from pure helpers in tests
 * that mock nothing, so detection has to degrade to English rather than throw.
 *
 * `vi.mock` intercepts `require` too, so a test that does mock `vscode` still
 * sees its stub here.
 */
function editorLanguage(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode') as { env?: { language?: string } };
    return vscode.env?.language;
  } catch {
    return undefined;
  }
}

function detectLocale(): Locale {
  const language = editorLanguage();
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLocale: Locale = detectLocale();

/**
 * Re-read the editor language. Call after the user changes
 * `workbench.locale` without reloading the window.
 */
export function refreshLocale(): void {
  currentLocale = detectLocale();
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate a key from the extension host's catalog.
 *
 * Resolution is locale → English → the key itself, matching
 * `i18n-shared`'s contract, so a missing key degrades to a visible key rather
 * than to an empty string.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(messages[currentLocale], messages.en, key, params);
}
