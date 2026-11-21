import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from '@moonshot-ai/kap-server';

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createDesktopAuthTokenService(homeDir: string, secret: string) {
  const tokenPath = serverTokenPath(homeDir);
  await loadOrCreateServerToken(homeDir).catch(() => {});
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
    if (cache !== undefined && st.mtimeMs === cache.mtimeMs && st.ino === cache.ino)
      return cache.token;
    cache = undefined;
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token.length > 0) cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
    } catch {}
    return cache?.token;
  };
  return {
    _serviceBrand: undefined,
    getToken: () => currentToken() ?? '',
    isValid: async (candidate: string) => {
      if (timingSafeMatch(candidate, secret)) return true;
      const token = currentToken();
      return token !== undefined && timingSafeMatch(candidate, token);
    },
  };
}
