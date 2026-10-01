import { describe, expect, it } from 'vitest';

import { getAllTips, getWorkingTips } from '#/tui/constant/tips';

describe('tips constants', () => {
  it('tip texts are unique across getAllTips()', () => {
    const texts = getAllTips().map((tip) => tip.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('every tip has a non-empty text', () => {
    for (const tip of getAllTips()) {
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });

  it('every tip has a positive priority when one is set', () => {
    for (const tip of getAllTips()) {
      if (tip.priority !== undefined) {
        expect(tip.priority).toBeGreaterThan(0);
      }
    }
  });

  it('getWorkingTips() is non-empty', () => {
    expect(getWorkingTips().length).toBeGreaterThan(0);
  });
});
