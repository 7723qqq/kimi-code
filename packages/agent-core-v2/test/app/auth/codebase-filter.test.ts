import { describe, expect, it } from 'bun:test';

import { isSensitivePath } from '#/app/auth/feedback/codebase/filter';

const sensitive = [
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
];

const notSensitive = [
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
];

describe('isSensitivePath', () => {
  for (const path of sensitive) {
    it(`treats ${path} as sensitive`, () => {
      expect(isSensitivePath(path)).toBe(true);
    });
  }

  for (const path of notSensitive) {
    it(`does not flag ${path}`, () => {
      expect(isSensitivePath(path)).toBe(false);
    });
  }

  it('still treats the exact-case spellings as sensitive after folding', () => {
    for (const path of ['.env', 'id_rsa', '.ssh/config', '.npmrc']) {
      expect(isSensitivePath(path)).toBe(true);
    }
  });
});
