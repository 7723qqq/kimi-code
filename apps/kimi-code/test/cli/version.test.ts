import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/kimi-code and reads its version', () => {
    // Located from this test file's own position, deliberately NOT through the
    // helpers under test: reading the expectation via `getHostPackageJsonPath()`
    // would make `getVersion()` compare itself to its own output.
    const expectedPath = resolve(import.meta.dirname, '..', '..', 'package.json');
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as { version: string };

    const resolved = getHostPackageJsonPath();
    expect(resolved.endsWith(join('apps', 'kimi-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(resolved));
    expect(getVersion()).toBe(expected.version);
  });

  it('builds the product user-agent for ad-hoc fetches', () => {
    expect(createKimiCodeUserAgent('1.2.3')).toBe('kimi-code-cli/1.2.3');
  });
});
