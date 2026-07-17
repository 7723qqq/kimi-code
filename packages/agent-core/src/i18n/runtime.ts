import { en } from './en';
import { zh } from './zh';
import type { Locale } from './types';

const messages: Record<Locale, object> = { en, zh };

let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function resolveMessage(key: string, locale: Locale): string | undefined {
  const parts = key.split('.');
  let current: unknown = messages[locale];
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}
