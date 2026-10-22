import { describe, expect, it } from 'bun:test';

import { detectLocaleNode } from '../src/detect.js';

/**
 * Guards the prefix-vs-subtag distinction: a prefix match on `zh`/`en` also
 * matches unrelated tags (`zho`, `enm`, `zhx`), which would silently pick a
 * locale the user did not ask for.
 */
describe('detectLocaleNode', () => {
  const saved = { ...process.env };

  const withEnv = (patch: Record<string, string | undefined>): ReturnType<typeof detectLocaleNode> => {
    for (const key of ['KIMI_LANG', 'LANG', 'LC_ALL', 'LC_MESSAGES']) delete process.env[key];
    Object.assign(process.env, patch);
    return detectLocaleNode();
  };

  it('maps zh and its regional variants to zh', () => {
    expect(withEnv({ KIMI_LANG: 'zh' })).toBe('zh');
    expect(withEnv({ KIMI_LANG: 'zh-CN' })).toBe('zh');
    expect(withEnv({ KIMI_LANG: 'zh_TW' })).toBe('zh');
    expect(withEnv({ KIMI_LANG: 'zh-Hans-CN' })).toBe('zh');
    expect(withEnv({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });

  it('maps en and its regional variants to en', () => {
    expect(withEnv({ KIMI_LANG: 'en' })).toBe('en');
    expect(withEnv({ KIMI_LANG: 'en-US' })).toBe('en');
    expect(withEnv({ LANG: 'en_GB.UTF-8' })).toBe('en');
  });

  it('does not treat unrelated tags as zh or en', () => {
    expect(withEnv({ KIMI_LANG: 'zho' })).toBe('en');
    expect(withEnv({ KIMI_LANG: 'zhx' })).toBe('en');
    expect(withEnv({ KIMI_LANG: 'enm' })).toBe('en');
    expect(withEnv({ KIMI_LANG: 'ja-JP' })).toBe('en');
  });

  it('prefers KIMI_LANG over the system locale', () => {
    expect(withEnv({ KIMI_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(withEnv({ KIMI_LANG: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh');
  });

  it('falls back to en when nothing is set', () => {
    expect(withEnv({})).toBe('en');
  });

  it('restores the environment afterwards', () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    expect(true).toBe(true);
  });
});
