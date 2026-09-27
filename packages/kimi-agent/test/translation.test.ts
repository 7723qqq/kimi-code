import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const native = require('../index.native.cjs') as {
  translate: (key: string, params?: Record<string, string> | null) => string;
  setEngineLocale: (locale: string) => void;
};

// The engine locale is process-wide, so a test that switches it and then fails
// would otherwise leave every later test resolving against the wrong catalog.
afterEach(() => {
  native.setEngineLocale('en');
});

describe('translate (embedded catalog)', () => {
  it('resolves a known key in English', () => {
    expect(native.translate('common.ok')).toBe('OK');
  });

  it('resolves the same key in Chinese', () => {
    native.setEngineLocale('zh');
    expect(native.translate('common.ok')).toBe('确定');
  });

  it('returns the key when it is in neither locale', () => {
    expect(native.translate('definitely.not.a.key')).toBe('definitely.not.a.key');
  });

  it('interpolates {{param}} placeholders', () => {
    const out = native.translate('tui.statusMessages.unsupportedEffort', {
      arg: '--effort=high',
      alias: '--reasoning-effort=high',
      segments: '3',
    });
    expect(out).toContain('--effort=high');
    expect(out).toContain('3');
  });

  it('leaves an unknown placeholder literal', () => {
    expect(native.translate('tui.statusMessages.shellCommandFailed', {})).toContain('{{');
  });

  it('ignores an unknown locale name', () => {
    native.setEngineLocale('fr');
    expect(native.translate('common.ok')).toBe('OK');
  });
});
