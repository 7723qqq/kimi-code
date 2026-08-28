import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

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
