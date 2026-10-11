import { afterEach, describe, expect, it } from 'vitest';

import { getLocale as getEngineLocale, t as engineT, setLocale as setEngineLocale } from '@moonshot-ai/kimi-i18n';

/**
 * The engine owns a translation instance of its own
 * (`@moonshot-ai/kimi-i18n`). Until the host forwards the UI language, that
 * instance keeps whatever `detectLocaleNode()` picked at module load, so
 * engine-side strings stay in the launch language after a `/settings` switch.
 * These assertions pin the channel the harness now uses.
 */
describe('engine locale channel', () => {
  afterEach(() => {
    setEngineLocale('en');
  });

  it('translates with the locale the host sets', () => {
    setEngineLocale('zh');
    expect(getEngineLocale()).toBe('zh');

    setEngineLocale('en');
    expect(getEngineLocale()).toBe('en');
  });

  it('reads a known engine key in both languages', () => {
    setEngineLocale('en');
    const en = engineT('toolsV2.sessionQuery.unknownOperation');
    setEngineLocale('zh');
    const zh = engineT('toolsV2.sessionQuery.unknownOperation');

    expect(en.length).toBeGreaterThan(0);
    expect(zh.length).toBeGreaterThan(0);
    expect(zh).not.toBe(en);
  });
});
