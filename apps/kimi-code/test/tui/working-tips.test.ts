import { describe, expect, it } from 'vitest';

import {
  getWorkingTips,
  currentWorkingTip,
  pickRandomWorkingTip,
} from '#/tui/components/chrome/working-tips';

describe('currentWorkingTip', () => {
  it('returns a tip from getWorkingTips()', () => {
    const now = Date.now();
    const tip = currentWorkingTip(now);
    expect(tip).toBeDefined();
    expect(getWorkingTips().some((t) => t.text === tip!.text)).toBe(true);
  });

  it('returns the same tip for the same timestamp', () => {
    const now = 1_000_000;
    const first = currentWorkingTip(now);
    const second = currentWorkingTip(now);
    expect(first).toBe(second);
  });

  it('returns a different tip for a different timestamp', () => {
    // Asserted, not guarded: an `if` here would turn the case below into a
    // silently empty test the day the rotation is ever trimmed to one entry.
    expect(getWorkingTips().length).toBeGreaterThan(1);
    const tip1 = currentWorkingTip(0);
    const tip2 = currentWorkingTip(10_000);
    // The timestamp-based rotation should produce a deterministic
    // but different result when the input changes significantly.
    expect(tip1).not.toBe(tip2);
  });
});

describe('pickRandomWorkingTip', () => {
  it('returns a tip from getWorkingTips()', () => {
    const tip = pickRandomWorkingTip();
    expect(tip).toBeDefined();
    expect(getWorkingTips().some((t) => t.text === tip!.text)).toBe(true);
  });

  it('avoids the excluded text when possible', () => {
    expect(getWorkingTips().length).toBeGreaterThan(1);
    const first = pickRandomWorkingTip()!;
    let different = false;
    for (let i = 0; i < 50; i++) {
      const next = pickRandomWorkingTip(first.text);
      if (next !== undefined && next.text !== first.text) {
        different = true;
        break;
      }
    }
    expect(different).toBe(true);
  });
});
