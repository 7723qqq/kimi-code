import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import lockfile from 'proper-lockfile';

import { OAuthError } from '../src/errors';
import { OAuthManager } from '../src/oauth-manager';
import type { TokenStorage } from '../src/storage';
import type { OAuthFlowConfig, TokenInfo } from '../src/types';

// `mock.module` rewrites the registry for the whole `bun test` process and
// cannot be undone, so every other file that reaches the POSIX lock path sees
// this mock too. The real `lock` is captured before the rewrite (calling the
// module from inside its own factory would recurse) and is the default path;
// only this file's test swaps in a rejecting implementation.
const realLock = lockfile.lock.bind(lockfile);
let lockImpl: typeof realLock = realLock;

void mock.module('proper-lockfile', () => ({
  default: {
    lock: (target: string, options?: Parameters<typeof realLock>[1]) => lockImpl(target, options),
  },
}));

class InMemoryStorage implements TokenStorage {
  public token: TokenInfo | undefined;

  async load(): Promise<TokenInfo | undefined> {
    return this.token;
  }

  async save(_name: string, token: TokenInfo): Promise<void> {
    this.token = token;
  }

  async remove(): Promise<void> {
    this.token = undefined;
  }

  async list(): Promise<string[]> {
    return this.token === undefined ? [] : ['kimi-code'];
  }
}

const config: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost: 'https://unused.test',
  clientId: 'test-client-id',
};

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: 1_000_000_100,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

describe('OAuthManager refresh lock failure', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `kimi-oauth-lock-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    lockImpl = realLock;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mock.restore();
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed instead of refreshing without a configured cross-process lock',
    async () => {
      const storage = new InMemoryStorage();
      storage.token = makeToken();
      lockImpl = async () => {
        throw new Error('lock busy');
      };
      const refreshImpl = mock().mockResolvedValue(makeToken({ accessToken: 'at-new' }));

      const mgr = new OAuthManager({
        config,
        storage,
        configDir: dir,
        now: () => 1_000_000_000,
        refreshTokenImpl: refreshImpl,
      });

      await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthError);
      await expect(mgr.ensureFresh()).rejects.toThrow(/refresh lock/i);
      expect(refreshImpl).not.toHaveBeenCalled();
    },
  );
});
