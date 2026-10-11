import { describe, it, expect } from 'vitest';

import en from '../src/i18n-locales/en';
import zh from '../src/i18n-locales/zh';
import enRuntimeTree from '../../i18n/src/locales/en';
import zhRuntimeTree from '../../i18n/src/locales/zh';

type MessageValue = string | { [key: string]: MessageValue };

function collectLeafKeys(obj: MessageValue, prefix = ''): string[] {
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

describe('kap-server i18n locale key consistency', () => {
  const enKeys = collectLeafKeys(en as unknown as MessageValue);
  const zhKeys = collectLeafKeys(zh as unknown as MessageValue);

  it('en and zh have the same number of leaf keys', () => {
    expect(enKeys.length).toBe(zhKeys.length);
  });

  it('every en key exists in zh', () => {
    const zhSet = new Set(zhKeys);
    const missing = enKeys.filter((k) => !zhSet.has(k));
    expect(missing).toEqual([]);
  });

  it('every zh key exists in en', () => {
    const enSet = new Set(enKeys);
    const missing = zhKeys.filter((k) => !enSet.has(k));
    expect(missing).toEqual([]);
  });

  it('stays a subset of the tree the server actually serves at runtime (`src/i18n.ts` re-exports the package locale, so a key only present in this copy never renders)', () => {
    const runtimeKeys = new Set(collectLeafKeys(enRuntimeTree as unknown as MessageValue));
    const absent = enKeys.filter((k) => !runtimeKeys.has(k));
    expect(absent, 'these keys exist only in the checked-in copy, so they never render').toEqual([]);
    expect(collectLeafKeys(zhRuntimeTree as unknown as MessageValue).length).toBeGreaterThan(0);
  });
});
