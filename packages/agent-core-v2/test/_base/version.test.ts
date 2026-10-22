import { describe, expect, it } from 'bun:test';

import { getCoreVersion } from '#/_base/version';

describe('version', () => {
  it('exposes a non-empty version string', () => {
    expect(typeof getCoreVersion()).toBe('string');
    expect(getCoreVersion().length).toBeGreaterThan(0);
  });
});
