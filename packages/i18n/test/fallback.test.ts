import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Force the pure-JS fallback path via environment variable.
// This is checked by tryLoadNative() before attempting to load the native module.
beforeEach(() => {
  process.env['KIMI_I18N_FORCE_JS'] = '1';
});

afterEach(() => {
  delete process.env['KIMI_I18N_FORCE_JS'];
});

import { t, setLocale, getLocale, getEngine } from '#/i18n';
import en from '#/locales/en';
import zh from '#/locales/zh';

describe('i18n fallback (KIMI_I18N_FORCE_JS=1)', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
  });

  it('getEngine() returns "js" when native module is forced off', () => {
    expect(getEngine()).toBe('js');
  });

  describe('t()', () => {
    it('returns the English string for a known key', () => {
      expect(t('errors.sessionNotFound')).toBe('Session not found');
    });

    it('returns the Chinese string when locale is zh', () => {
      setLocale('zh');
      expect(t('errors.sessionNotFound')).toBe('未找到会话');
    });

    it('returns the key itself when key does not exist in any locale', () => {
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', () => {
      expect(t('plugin.manifestNotFound', { path: '/foo/bar' })).toContain('/foo/bar');
    });

    it('handles empty params object', () => {
      expect(t('errors.internal', {})).toBe('Internal error');
    });

    it('handles multiple params', () => {
      const result = t('v2Errors.goalObjectiveTooLongAction', { max: '4000' });
      expect(result).toContain('4000');
    });

    it('keeps placeholder when param is missing', () => {
      const result = t('plugin.manifestNotFound', {});
      expect(result).toContain('{{path}}');
    });
  });

  describe('setLocale() / getLocale()', () => {
    it('getLocale returns the current locale', () => {
      setLocale('zh');
      expect(getLocale()).toBe('zh');
      setLocale('en');
      expect(getLocale()).toBe('en');
    });

    it('setLocale ignores invalid locale values', () => {
      setLocale('en');
      setLocale('fr' as any);
      expect(getLocale()).toBe('en');
    });
  });

  describe('locale key consistency', () => {
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
  });
});