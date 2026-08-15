/**
 * `auth` domain (cross-cutting) — GitHub README fetcher, ported from the
 * open-websearch project (`engines/github/github.js`). Extracts the
 * owner/repo pair from a GitHub repository URL (HTTPS or SSH, tolerating
 * query params, fragments and sub-paths) and fetches the repository README
 * from `raw.githubusercontent.com` through `engineFetch` (or the injected
 * `fetchImpl` in tests), trying a fixed list of README filename candidates
 * under the `HEAD` ref. The GitHub README API is deliberately avoided —
 * anonymous API requests hit rate limits quickly, while raw URLs are more
 * stable. The original engine has no search function and no playwright
 * path. Genuine fetch failures throw `Error2` (`WEB_FETCH_FAILED`); a
 * repository without a readable README yields `undefined`.
 */

import { Error2, ErrorCodes } from '#/errors';

import { engineFetch, type EngineHttpResponse } from '../engine-http';
import type { ArticleFetchFn, SearchEngineOptions } from '../types';

const README_CANDIDATES = [
  'README.md',
  'README.mdx',
  'README.markdown',
  'README',
  'README.txt',
  'readme.md',
  'readme.mdx',
  'readme.markdown',
  'readme',
  'readme.txt',
];

const REQUEST_TIMEOUT_MS = 10_000;

const README_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHub-README-Fetcher/1.0',
};

interface RepoInfo {
  owner: string;
  repo: string;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

function extractOwnerAndRepo(url: string): RepoInfo | null {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)/i,
    /git@github\.com:([^/\s]+)\/([^/\s]+)\.git/i,
  ];
  const trimmedUrl = url.trim();
  for (const pattern of patterns) {
    const match = trimmedUrl.match(pattern);
    if (match !== null) {
      const owner = match[1];
      const rawRepo = match[2];
      if (owner !== undefined && rawRepo !== undefined) {
        const repo = rawRepo.replaceAll(/(?:[?#].*$|\.git$|\/.*$)/g, '');
        if (owner.trim() !== '' && repo.trim() !== '') {
          return { owner: owner.trim(), repo: repo.trim() };
        }
      }
    }
  }
  return null;
}

async function fetchRawReadme(
  rawUrl: string,
  options: SearchEngineOptions,
): Promise<string | undefined> {
  let response: EngineHttpResponse;
  try {
    if (options.fetchImpl !== undefined) {
      const native = await options.fetchImpl(rawUrl, {
        headers: README_HEADERS,
        signal: options.signal,
      });
      response = {
        ok: native.ok,
        status: native.status,
        statusText: native.statusText,
        text: () => native.text(),
        stream: () => native.body,
        header: (name: string) => native.headers.get(name),
      };
    } else {
      if (options.signal?.aborted === true) {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      response = await engineFetch(rawUrl, {
        headers: README_HEADERS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `GitHub README request to ${rawUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `GitHub README request failed: HTTP ${String(response.status)}.`,
      {
        details: { status: response.status },
      },
    );
  }
  return response.text();
}

async function fetchReadme(
  owner: string,
  repo: string,
  options: SearchEngineOptions,
): Promise<string | undefined> {
  let sawFetchFailure = false;
  for (const readmeFile of README_CANDIDATES) {
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${readmeFile}`;
    const content = await fetchRawReadme(rawUrl, options);
    if (content === undefined) {
      continue;
    }
    if (content.trim() !== '') {
      return content;
    }
    sawFetchFailure = true;
    console.warn(`Empty or invalid README content for ${owner}/${repo} at ${readmeFile}`);
  }
  if (sawFetchFailure) {
    console.warn(`Failed to fetch README for ${owner}/${repo}`);
  } else {
    console.warn(`README not found for ${owner}/${repo}`);
  }
  return undefined;
}

async function getReadmeFromUrl(
  githubUrl: string,
  options: SearchEngineOptions,
): Promise<{ content: string } | undefined> {
  const repoInfo = extractOwnerAndRepo(githubUrl);
  if (repoInfo === null) {
    console.warn(`Unable to extract owner and repo from URL: ${githubUrl}`);
    return undefined;
  }
  const content = await fetchReadme(repoInfo.owner, repoInfo.repo, options);
  if (content !== undefined) {
    return { content };
  }
  return undefined;
}

export const fetchGithubReadme: ArticleFetchFn = (githubUrl, options = {}) =>
  getReadmeFromUrl(githubUrl, options);
