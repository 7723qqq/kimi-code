/**
 * Shared i18n — types, translate, and locale detection.
 *
 * The main entry re-exports pure-JS utilities that work in both
 * Node.js and browser environments.
 *
 * For the in-process factory used by the CLI, see `apps/kimi-code/src/i18n/index.ts`.
 * For the browser factory, import from:
 * - `@moonshot-ai/i18n-shared/web`  — Pure-JS browser factory (with React hook)
 */

export type { Locale, MessageValue, TranslationKey, I18nInstance, LocaleMeta } from './types.js';

export { collectLeafKeys, LOCALES, DEFAULT_LOCALE, localeMeta, otherLocale } from './types.js';
export { resolveMessage, interpolate, translate } from './core.js';
export { detectLocale, detectLocaleNode, detectLocaleWeb } from './detect.js';
