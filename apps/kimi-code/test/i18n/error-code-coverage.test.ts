import { describe, expect, it } from 'bun:test';

import en from '#/i18n/locales/en';
import zh from '#/i18n/locales/zh';

import { ErrorCodes } from '@moonshot-ai/agent-core-v2';

const camelCaseCode = (code: string): string =>
  code
    .split(/[._]/)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

const codes = [...new Set(Object.values(ErrorCodes))].sort();

function leaves(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      keys.push(...leaves(value as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

const enKeys = new Set(leaves(en));
const zhKeys = new Set(leaves(zh));

describe('error code locale contract', () => {
  it('declares every engine error code in both locales', () => {
    const missing = codes
      .map((code) => `errorCodes.${camelCaseCode(code)}`)
      .filter((key) => !enKeys.has(key) || !zhKeys.has(key));

    expect(missing).toEqual([]);
  });

  it('never lets a localized error title fall back to the key itself', () => {
    const camel = codes.map((code) => camelCaseCode(code));
    const enCodes = en.errorCodes as Record<string, string | undefined>;
    const zhCodes = zh.errorCodes as Record<string, string | undefined>;
    const blank = camel.filter((name) => {
      const enValue = enCodes[name];
      const zhValue = zhCodes[name];
      return (
        typeof enValue !== 'string' ||
        enValue.trim().length === 0 ||
        typeof zhValue !== 'string' ||
        zhValue.trim().length === 0
      );
    });

    expect(blank).toEqual([]);
  });
});
