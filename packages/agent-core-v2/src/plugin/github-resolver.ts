import type { GithubRef } from './source';
import type { PluginGithubRef } from './types';

export interface GithubSourceInput {
  readonly kind: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly ref?: GithubRef;
}

export interface GithubSourceResolution {
  readonly tarballUrl: string;
  readonly displayVersion: string;
  readonly ref: PluginGithubRef;
}

/**
 * Resolve a `github` source descriptor to a downloadable zip URL.
 *
 * Hot path is the bare-URL case (no explicit ref). We deliberately avoid
 * `api.github.com` because its anonymous quota is shared with the user's
 * browser, gh CLI, IDE integrations, etc.
 */
export async function resolveGithubSource(
  input: GithubSourceInput,
): Promise<GithubSourceResolution> {
  const { owner, repo } = input;

  if (input.ref !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, input.ref),
      displayVersion: input.ref.value,
      ref: { kind: input.ref.kind, value: input.ref.value },
    };
  }

  const latestTag = await tryResolveLatestReleaseTag(owner, repo);
  if (latestTag !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, { kind: 'tag', value: latestTag }),
      displayVersion: latestTag,
      ref: { kind: 'tag', value: latestTag },
    };
  }

  const headProbe = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/HEAD`, {
    method: 'HEAD',
  });
  if (headProbe.status === 404) {
    throw new Error(`Repository \`${owner}/${repo}\` not found or not accessible.`);
  }
  if (!headProbe.ok) {
    throw new Error(
      `Could not access \`${owner}/${repo}\`: HTTP ${headProbe.status} ${headProbe.statusText}.`,
    );
  }
  return {
    tarballUrl: `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    displayVersion: 'HEAD',
    ref: { kind: 'branch', value: 'HEAD' },
  };
}

async function tryResolveLatestReleaseTag(owner: string, repo: string): Promise<string | undefined> {
  const url = `https://github.com/${owner}/${repo}/releases/latest`;
  const resp = await fetch(url, { redirect: 'manual' });

  if (resp.status === 404) return undefined;

  if (resp.status !== 301 && resp.status !== 302) {
    throw new Error(
      `Could not look up latest release of \`${owner}/${repo}\`: ` +
        `HTTP ${resp.status} ${resp.statusText} (${url}). ` +
        `Pin a specific ref with \`/tree/<branch|tag|sha>\` to bypass release lookup.`,
    );
  }

  const location = resp.headers.get('location');
  if (location === null) return undefined;

  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function codeloadUrl(owner: string, repo: string, ref: GithubRef): string {
  const base = `https://codeload.github.com/${owner}/${repo}/zip`;
  const encoded = encodeCodeloadRefPath(ref.value);
  if (ref.kind === 'sha') return `${base}/${encoded}`;
  if (ref.kind === 'tag') return `${base}/refs/tags/${encoded}`;
  return `${base}/${encoded}`;
}

function encodeCodeloadRefPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}
