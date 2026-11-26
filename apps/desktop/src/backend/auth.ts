import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from '@moonshot-ai/kap-server';

import type { DesktopBackendAuth } from './desktopBackend';

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDesktopAuthTokenService(homeDir: string, launchSecret = ''): DesktopBackendAuth {
  const tokenPath = serverTokenPath(homeDir);
  void loadOrCreateServerToken(homeDir).catch(() => {});
  let cache: { token: string; mtimeMs: number; ino: number } | undefined;
  const currentToken = (): string | undefined => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(tokenPath);
    } catch {
      cache = undefined;
      return undefined;
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      cache = undefined;
      return undefined;
    }
    if (cache !== undefined && st.mtimeMs === cache.mtimeMs && st.ino === cache.ino) {
      return cache.token;
    }
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token.length > 0) {
        cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    } catch {
    }
    return cache?.token;
  };
  return {
    _serviceBrand: undefined,
    getToken: () => currentToken() ?? '',
    isValid: (candidate: string) => {
      if (timingSafeMatch(candidate, launchSecret)) return Promise.resolve(true);
      const token = currentToken();
      return Promise.resolve(token !== undefined && timingSafeMatch(candidate, token));
    },
  };
}
