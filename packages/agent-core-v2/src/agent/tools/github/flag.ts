import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { registerFlagDefinition, type FlagDefinitionInput } from '#/app/flag/flagRegistry';

export const GITHUB_TOOLS_FLAG_ID = 'github_tools';
export const GITHUB_TOOLS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_GITHUB_TOOLS';

export const githubToolsFlag: FlagDefinitionInput = {
  id: GITHUB_TOOLS_FLAG_ID,
  title: 'GitHub tools',
  description:
    'Built-in GitHub REST tools (repos, files, issues, pull requests, search) backed by an HTTP transport. Requires a GITHUB_TOKEN or GH_TOKEN environment variable, or set token in the [github] config section.',
  env: GITHUB_TOOLS_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(githubToolsFlag);

export const GITHUB_CONFIG_SECTION = 'github';

export const GithubConfigSchema = z.object({
  token: z
    .string()
    .optional()
    .describe('GitHub personal access token used by the built-in GitHub tools.'),
});

registerConfigSection(GITHUB_CONFIG_SECTION, GithubConfigSchema, { defaultValue: {} });
