import { describe, expect, it } from 'bun:test';

import { isSensitivePath } from '#/feedback/codebase/filter';

/**
 * The upload path's only sensitive-data gate. On a case-insensitive filesystem
 * (macOS, Windows) `.ENV` IS `.env`, so each positive case below is paired with
 * the exact-case spelling of the same file.
 */
describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.ENV',
    '.Env',
    'config/.env',
    'id_rsa',
    'ID_RSA',
    'id_ed25519',
    'ID_ED25519',
    'Server.Key',
    'SERVER.KEY',
    'credentials.json',
    'Credentials.Json',
    '.netrc',
    '.NPMRC',
    '.env.local',
    '.SSH/config',
    '.Aws/credentials',
    '.Kube/config',
  ])('treats %s as sensitive', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    '.env.example',
    '.ENV.EXAMPLE',
    '.Env.Sample',
    '.env.template',
    'src/app.ts',
    'docs/README.md',
    'src/env.ts',
    'server.key.pub',
    'package.json',
    '.gitignore',
  ])('does not flag %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it('still treats the exact-case spellings as sensitive after folding', () => {
    for (const path of ['.env', 'id_rsa', '.ssh/config', '.npmrc']) {
      expect(isSensitivePath(path)).toBe(true);
    }
  });
});
