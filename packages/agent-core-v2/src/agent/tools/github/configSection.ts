import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import {
  GITHUB_PROXY_DEFAULT_DOMAINS,
  GITHUB_PROXY_DEFAULT_MIRROR_HOSTS,
} from './github-proxy';

export const GITHUB_SECTION = 'github';

export const GithubConfigSchema = z.object({
  token: z
    .string()
    .optional()
    .describe('GitHub personal access token used by the built-in GitHub tools.'),
  baseUrl: z
    .string()
    .optional()
    .describe('GitHub REST API base URL. Set it to reach a GitHub Enterprise Server instance.'),
});

export type GithubConfig = z.infer<typeof GithubConfigSchema>;

registerConfigSection(GITHUB_SECTION, GithubConfigSchema, { defaultValue: {} });

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function resolveGitHubToken(config: IConfigService): string | undefined {
  return nonEmpty(config.get<GithubConfig>(GITHUB_SECTION)?.token);
}

export function resolveGitHubBaseUrl(config: IConfigService): string | undefined {
  return nonEmpty(config.get<GithubConfig>(GITHUB_SECTION)?.baseUrl);
}

export function hasGitHubToken(config: IConfigService): boolean {
  return resolveGitHubToken(config) !== undefined;
}

export const GITHUB_PROXY_SECTION = 'github_proxy';

export const GitHubProxyConfigSchema = z
  .object({
    proxy: z
      .string()
      .optional()
      .describe('HTTP(S) or SOCKS proxy applied only to GitHub traffic.'),
    mirror: z
      .string()
      .optional()
      .describe('Mirror base URL. GitHub downloads are rewritten through it using the gh-proxy convention.'),
    domains: z
      .array(z.string())
      .optional()
      .describe('Host patterns treated as GitHub traffic. `*.example.com` matches subdomains only.'),
    mirrorHosts: z
      .array(z.string())
      .optional()
      .describe('Host patterns eligible for mirror rewriting. Defaults to GitHub download hosts only.'),
    fallback: z
      .boolean()
      .optional()
      .describe('Retry the original URL directly when the proxy or mirror fails. Defaults to true.'),
  })
  .optional();

export type GitHubProxyConfig = z.infer<typeof GitHubProxyConfigSchema>;

registerConfigSection(GITHUB_PROXY_SECTION, GitHubProxyConfigSchema, { defaultValue: {} });

export function resolveGitHubProxyConfig(config: IConfigService): {
  readonly proxy: string | undefined;
  readonly mirror: string | undefined;
  readonly domains: readonly string[];
  readonly mirrorHosts: readonly string[];
  readonly fallback: boolean;
} {
  const raw = config.get<GitHubProxyConfig>(GITHUB_PROXY_SECTION);
  const cleaned = (values: readonly string[] | undefined): readonly string[] =>
    (values ?? []).filter((value) => value.trim().length > 0);
  const domains = cleaned(raw?.domains);
  const mirrorHosts = cleaned(raw?.mirrorHosts);
  return {
    proxy: nonEmpty(raw?.proxy),
    mirror: nonEmpty(raw?.mirror),
    domains: domains.length > 0 ? domains : GITHUB_PROXY_DEFAULT_DOMAINS,
    mirrorHosts: mirrorHosts.length > 0 ? mirrorHosts : GITHUB_PROXY_DEFAULT_MIRROR_HOSTS,
    fallback: raw?.fallback !== false,
  };
}
