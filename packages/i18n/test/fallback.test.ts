import { createRequire } from 'node:module';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { t, setLocale, getEngine } from '#/i18n';

// `loadNativeImpl()` reads this on its first call and `_native` memoizes the
// answer for the life of the module, so it must be in place before the first
// `t()`. That is why this is a separate file and not a `describe` nested in
// `i18n.test.ts`: vitest isolates modules per file, so that file's first `t()`
// would already have locked in the native path.
beforeEach(() => {
  process.env['KIMI_I18N_FORCE_JS'] = '1';
});

afterEach(() => {
  delete process.env['KIMI_I18N_FORCE_JS'];
  setLocale('en');
});

describe('i18n pure-JS fallback (KIMI_I18N_FORCE_JS=1)', () => {
  it('reports the js engine, and the addon it diverted from does load', () => {
    // Without the second assertion `'js'` would also be what a broken or
    // missing native build reports, and the rest of this file would pass
    // vacuously. The addon is a direct dependency of this package, so proving
    // it resolves and carries `translate` makes the env var the only
    // remaining explanation.
    const native = createRequire(import.meta.url)('@moonshot-ai/kimi-agent/native') as {
      translate?: unknown;
    };
    expect(typeof native.translate).toBe('function');
    expect(getEngine()).toBe('js');
  });

  it('t() reads the JS catalog, in both locales', () => {
    expect(t('common.ok')).toBe('OK');
    setLocale('zh');
    expect(t('common.ok')).toBe('确定');
  });

  it('returns the key itself when neither locale defines it', () => {
    expect(t('nonexistent.key.here')).toBe('nonexistent.key.here');
  });

  it('substitutes a {{param}} against the JS template', () => {
    expect(t('plugin.manifestNotFound', { path: '/foo/bar' })).toContain('/foo/bar');
  });

  it('leaves a {{param}} literal when the binding is absent', () => {
    expect(t('plugin.manifestNotFound', {})).toContain('{{path}}');
  });

  it('passes the template through untouched when no params are passed', () => {
    expect(t('plugin.manifestNotFound')).toBe('No manifest at {{path}}');
  });
});
