/**
 * `tools` domain — GitHub REST API transport (TypeScript).
 *
 * Pure HTTP layer used by the built-in GitHub tools. Owns auth (bearer token
 * resolution: explicit per-request token, then `GITHUB_TOKEN`, then
 * `GH_TOKEN`), request headers, a 30s deadline, and error normalization —
 * behavior aligned with the v1 native Rust transport (`nativeGithubRequest`).
 * Query values are stringified and `null`/`undefined` entries dropped, the
 * rate limit is read from the `x-ratelimit-remaining` response header, and
 * non-2xx responses normalize to `GitHub API error <status>` with the raw
 * body preserved for the caller to surface. The `fetchImpl` / `getEnv`
 * dependencies are injectable so tests can mock the network and the
 * environment. Pure helper; no scoped service.
 */

import { createDeadlineAbortSignal } from '#/_base/utils/abort';

export const GITHUB_DEFAULT_BASE_URL = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'kimi-code';
export const GITHUB_DEFAULT_ACCEPT = 'application/vnd.github+json';
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export const GITHUB_NO_TOKEN_ERROR =
  'No GitHub token found. Set the GITHUB_TOKEN (or GH_TOKEN) environment variable.';

export interface GitHubRequestOptions {
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly accept?: string;
  /** Explicit per-request token; when set, takes precedence over the env. */
  readonly token?: string;
}

export interface GitHubRequestDeps {
  readonly fetchImpl?: typeof fetch;
  readonly getEnv?: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
}

export interface GitHubRequestResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly error?: string;
  readonly rateRemaining?: number;
}

export async function githubRequest(
  method: string,
  path: string,
  options: GitHubRequestOptions = {},
  deps: GitHubRequestDeps = {},
): Promise<GitHubRequestResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const token = firstNonEmpty(options.token, getEnv('GITHUB_TOKEN'), getEnv('GH_TOKEN'));
  if (token === undefined) {
    return { status: 0, ok: false, body: '', error: GITHUB_NO_TOKEN_ERROR };
  }

  const baseUrl = firstNonEmpty(getEnv('GITHUB_API_URL'), GITHUB_DEFAULT_BASE_URL) ?? GITHUB_DEFAULT_BASE_URL;
  const url = `${buildGitHubUrl(baseUrl, path)}${buildGitHubQuery(options.query)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: options.accept ?? GITHUB_DEFAULT_ACCEPT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  };
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const deadline = createDeadlineAbortSignal(
    deps.signal ?? new AbortController().signal,
    GITHUB_REQUEST_TIMEOUT_MS,
  );
  try {
    init.signal = deadline.signal;
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (deadline.timedOut()) {
        return {
          status: 0,
          ok: false,
          body: '',
          error: `network error: GitHub request timed out after ${String(GITHUB_REQUEST_TIMEOUT_MS / 1000)}s`,
        };
      }
      throw error;
    }
    const bodyText = await response.text();
    const rateRemaining = parseRateLimitRemaining(response.headers.get('x-ratelimit-remaining'));
    if (!response.ok) {
      return {
        status: response.status,
        ok: false,
        body: bodyText,
        error: `GitHub API error ${String(response.status)}`,
        rateRemaining,
      };
    }
    return { status: response.status, ok: true, body: bodyText, rateRemaining };
  } catch (error) {
    if (deps.signal !== undefined && deps.signal.aborted) throw error;
    return {
      status: 0,
      ok: false,
      body: '',
      error: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    deadline.clear();
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Join `base` and `path`; an absolute URL in `path` is returned unchanged. */
function buildGitHubUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const trimmedBase = base.replace(/\/+$/, '');
  return path.startsWith('/') ? `${trimmedBase}${path}` : `${trimmedBase}/${path}`;
}

/**
 * Serialize a query object into a URL query string. String/number/bool values
 * are stringified; `null` and `undefined` entries are dropped (matching the
 * v1 transport, where optional fields are simply absent).
 */
function buildGitHubQuery(query: Record<string, unknown> | undefined): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value as string | number | boolean))}`);
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function parseRateLimitRemaining(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}
