import { createRequire } from 'node:module';

import { zh } from '@moonshot-ai/i18n-catalog';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { t, setLocale, getLocale } from '#/i18n';

describe('i18n', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
  });

  describe('t()', () => {
    it('returns the English string for a known key', () => {
      expect(t('common.ok')).toBe('OK');
    });

    it('returns the Chinese string when locale is zh', () => {
      setLocale('zh');
      expect(t('common.ok')).toBe('确定');
    });

    it('returns the key itself when key does not exist in any locale', () => {
      expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
    });

    it('interpolates {{param}} placeholders', () => {
      setLocale('en');
      expect(t('tui.statusMessages.shellCommandFailed', { message: 'ENOENT' })).toContain('ENOENT');
    });

    it('handles empty params object', () => {
      setLocale('en');
      expect(t('common.ok', {})).toBe('OK');
    });

    it('handles multiple params', () => {
      setLocale('en');
      const result = t('tui.statusMessages.unsupportedEffort', {
        arg: 'high',
        alias: 'gpt-4',
        segments: 'low, medium',
      });
      expect(result).toContain('high');
      expect(result).toContain('gpt-4');
      expect(result).toContain('low, medium');
    });

    it('keeps placeholder when param is missing', () => {
      setLocale('en');
      const result = t('tui.statusMessages.shellCommandFailed', {});
      expect(result).toContain('{{message}}');
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

  describe('engine locale sync', () => {
    /**
     * `setEngineLocale` names the locale for the engine's embedded catalog,
     * which is what the napi `translate` binding — and therefore this file's
     * own `t()` — resolves against. Without that install every string comes
     * back English, so the wiring, not just the types, needs covering.
     *
     * It is also the locale a `LocalizedText` resolves against, so the engine's
     * own user-facing text follows the language named here.
     *
     * The catalog is embedded in the engine binary, so the payload is a locale
     * name and nothing else. What proves the two sides agree is that the engine
     * resolves a key the host also resolves, in the language just named.
     */
    interface NativeModule {
      setEngineLocale?: (locale: string) => void;
      translate?: (key: string) => string;
    }

    function spyOnEngineLocale(): {
      calls: string[];
      native: NativeModule;
      restore: () => void;
    } {
      const native = createRequire(import.meta.url)(
        '@moonshot-ai/kimi-agent/native',
      ) as NativeModule;
      const original = native.setEngineLocale;
      const calls: string[] = [];
      native.setEngineLocale = (locale) => {
        calls.push(locale);
        original?.(locale);
      };
      return { calls, native, restore: () => (native.setEngineLocale = original) };
    }

    it('re-installs the engine locale when the host locale switches', () => {
      const { calls, restore } = spyOnEngineLocale();
      try {
        setLocale('zh');
        expect(calls.at(-1), 'setEngineLocale was never called').toBe('zh');
        setLocale('en');
        expect(calls.at(-1)).toBe('en');
      } finally {
        restore();
      }
    });

    it('hands the engine a locale it resolves the same key from', () => {
      const { native, restore } = spyOnEngineLocale();
      try {
        setLocale('zh');
        // A key the host can translate must come back in the language the host
        // just named, otherwise the two would drift apart on the same locale.
        expect(native.translate?.('common.ok')).toBe(zh.common.ok);
      } finally {
        restore();
      }
    });
  });

});
