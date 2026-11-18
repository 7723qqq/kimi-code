import { randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';
import type { IAuthTokenService } from '../services/auth/authTokenService';
import type { CredentialValidator } from '../services/auth/credentials';
import { AUTH_RATE_LIMIT_CODE, AUTH_RATE_LIMIT_MSG, type AuthFailureLimiter } from './rateLimit';

const AUTH_ERROR_CODE = 40101;
const AUTH_ERROR_MSG = 'Unauthorized';
const REDACTED = '[redacted]';
const BEARER_PREFIX = 'Bearer ';
const DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_GRANTS = 128;

interface DownloadGrant {
  readonly credential: string;
  readonly host: string;
  readonly expiresAt: number;
}

function isBrowserDownload(req: FastifyRequest): boolean {
  if (req.method !== 'GET' || req.headers['sec-fetch-site'] !== 'same-origin') return false;
  const path = decodeRequestPath(req.url);
  return (
    path !== null &&
    (/^\/api\/v1\/files\/[^/]+$/.test(path) ||
      /^\/api\/v1\/sessions\/[^/]+\/media\/[^/]+$/.test(path) ||
      /^\/api\/v1\/sessions\/[^/]+\/fs\/.+:download$/.test(path))
  );
}

function downloadCookieName(host: string): string {
  return `kimi_download_${new Bun.CryptoHasher('sha256').update(host).digest('hex').slice(0, 12)}`;
}

function cookieValue(req: FastifyRequest, name: string): string | undefined {
  const parts = req.headers.cookie?.split(';').map((part) => part.trim());
  return parts?.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function grantKey(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export interface AuthHookOptions {
  readonly isBypassed?: (req: FastifyRequest) => boolean;
  readonly limiter?: Pick<AuthFailureLimiter, 'recordFailure' | 'isBanned'>;
  readonly validateCredential?: CredentialValidator;
}

function decodeRequestPath(rawUrl: string): string | null {
  const path = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function defaultIsBypassed(req: FastifyRequest): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = decodeRequestPath(req.url);
  if (path === null) {
    return false;
  }
  if (req.method === 'GET' && path === '/api/v1/healthz') {
    return true;
  }
  const isApi = path.startsWith('/api/');
  const isMeta = path === '/openapi.json' || path === '/asyncapi.json';
  return !isApi && !isMeta;
}

function extractBearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : token;
}

export function createAuthHook(
  authTokenService: IAuthTokenService,
  opts?: AuthHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  const isBypassed = opts?.isBypassed ?? defaultIsBypassed;
  const validateCredential: CredentialValidator =
    opts?.validateCredential ?? ((candidate) => authTokenService.isValid(candidate));
  const downloads = new Map<string, DownloadGrant>();

  return async (req, reply) => {
    if (opts?.limiter?.isBanned(req.ip) === true) {
      return reply.code(429).send(errEnvelope(AUTH_RATE_LIMIT_CODE, AUTH_RATE_LIMIT_MSG, req.id));
    }

    const header = req.headers.authorization;
    const token = extractBearer(header);

    if (isBypassed(req)) {
      return;
    }

    if (header !== undefined) {
      req.headers.authorization = REDACTED;
    }

    const host = req.headers.host ?? '';
    const cookieName = downloadCookieName(host);
    const value = cookieValue(req, cookieName);
    if (req.headers.cookie !== undefined) req.headers.cookie = REDACTED;
    const now = Date.now();
    for (const [key, grant] of downloads) if (grant.expiresAt <= now) downloads.delete(key);
    if (token === null) {
      const grant =
        header === undefined && isBrowserDownload(req) && value !== undefined
          ? downloads.get(grantKey(value))
          : undefined;
      if (
        grant !== undefined &&
        grant.host === host &&
        (await validateCredential(grant.credential))
      )
        return;
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }

    if (!(await validateCredential(token))) {
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }
    if (req.method === 'GET' && req.headers['sec-fetch-site'] === 'same-origin' && host !== '') {
      const existing = value === undefined ? undefined : downloads.get(grantKey(value));
      if (
        existing === undefined ||
        existing.credential !== token ||
        existing.expiresAt - now < DOWNLOAD_GRANT_TTL_MS / 2
      ) {
        if (value !== undefined) downloads.delete(grantKey(value));
        while (downloads.size >= MAX_DOWNLOAD_GRANTS)
          downloads.delete(downloads.keys().next().value!);
        const id = randomBytes(32).toString('hex');
        downloads.set(grantKey(id), {
          credential: token,
          host,
          expiresAt: now + DOWNLOAD_GRANT_TTL_MS,
        });
        const secure = req.protocol === 'https' ? '; Secure' : '';
        reply.header(
          'set-cookie',
          `${cookieName}=${id}; Path=/api/v1; Max-Age=${DOWNLOAD_GRANT_TTL_MS / 1000}; HttpOnly; SameSite=Strict${secure}`,
        );
      }
    }
  };
}
