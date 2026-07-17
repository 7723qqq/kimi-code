import { getLocale, resolveMessage, setLocale } from './runtime';
import type { TranslationKey } from './types';

export function t(
  key: TranslationKey | (string & {}),
  params?: Record<string, string | number>,
): string {
  const locale = getLocale();
  let msg = resolveMessage(key, locale) ?? resolveMessage(key, 'en') ?? key;
  if (params) {
    msg = msg.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      params[name] !== undefined ? String(params[name]) : `{{${name}}}`,
    );
  }
  return msg;
}

export { setLocale, getLocale } from './runtime';
export type { Locale, TranslationKey } from './types';
