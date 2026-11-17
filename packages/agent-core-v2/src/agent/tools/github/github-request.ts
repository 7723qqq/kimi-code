import { createDeadlineAbortSignal } from '#/_base/utils/abort';
import type { FetchLike } from '#/_base/utils/fetchLike';

export const GITHUB_DEFAULT_BASE_URL = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_USER_AGENT = 'kimi-code';
export const GITHUB_DEFAULT_ACCEPT = 'application/vnd.github+json';
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
export const GITHUB_MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024;

export const GITHUB_NO_TOKEN_ERROR =
  'No GitHub token configured. Set token in the [github] section of config.toml, or set the GITHUB_TOKEN (or GH_TOKEN) environment variable.';

export interface GitHubRequestOptions {
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly accept?: string;
  readonly token?: string;
  readonly baseUrl?: string;
  readonly maxBytes?: number;
}

export interface GitHubRequestDeps {
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
}

export interface GitHubRequestResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  readonly error?: string;
  readonly rateRemaining?: number;
  readonly nextPage?: boolean;
  readonly etag?: string;
  readonly truncatedBytes?: number;
}

export async function githubRequest(
  method: string,
  path: string,
  options: GitHubRequestOptions = {},
  deps: GitHubRequestDeps = {},
): Promise<GitHubRequestResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const token = firstNonEmpty(options.token);
  if (token === undefined) {
    return { status: 0, ok: false, body: '', error: GITHUB_NO_TOKEN_ERROR };
  }

  const baseUrl =
    firstNonEmpty(options.baseUrl, GITHUB_DEFAULT_BASE_URL) ?? GITHUB_DEFAULT_BASE_URL;
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
    const rateRemaining = parseRateLimitRemaining(response.headers.get('x-ratelimit-remaining'));
    const nextPage = parseNextPage(response.headers.get('link'));
    const rawBody = await readResponseBody(
      response,
      Math.min(options.maxBytes ?? GITHUB_MAX_RESPONSE_BODY_BYTES, GITHUB_MAX_RESPONSE_BODY_BYTES),
    );
    const bodyText = rawBody.text;
    const truncatedBytes = rawBody.truncatedBytes;
    if (!response.ok) {
      return {
        status: response.status,
        ok: false,
        body: bodyText,
        error: `GitHub API error ${String(response.status)}`,
        rateRemaining,
        ...(nextPage ? { nextPage } : {}),
        ...(truncatedBytes > 0 ? { truncatedBytes } : {}),
      };
    }
    return {
      status: response.status,
      ok: true,
      body: bodyText,
      rateRemaining,
      ...(nextPage ? { nextPage } : {}),
      ...(truncatedBytes > 0 ? { truncatedBytes } : {}),
    };
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

function buildGitHubUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const trimmedBase = base.replace(/\/+$/, '');
  return path.startsWith('/') ? `${trimmedBase}${path}` : `${trimmedBase}/${path}`;
}

function buildGitHubQuery(query: Record<string, unknown> | undefined): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    pairs.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value as string | number | boolean))}`,
    );
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function parseRateLimitRemaining(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncatedBytes: number }> {
  if (response.body === null) return { text: '', truncatedBytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncatedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        received += remaining;
      }
      truncatedBytes += value.byteLength - Math.max(0, remaining);
      await reader.cancel();
      continue;
    }
    received += value.byteLength;
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (truncatedBytes === 0) return { text, truncatedBytes: 0 };
  const marker = `\n[...truncated ${String(truncatedBytes)}+ bytes]`;
  return { text: `${text}${marker}`, truncatedBytes };
}

function parseNextPage(link: string | null): boolean {
  return link !== null && /rel="next"/.test(link);
}
