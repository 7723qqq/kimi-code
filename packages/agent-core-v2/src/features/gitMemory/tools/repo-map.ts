import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const REPO_MAP_TOOL_NAME = 'RepoMap' as const;

export interface RepoMapInput {
  path?: string;
  depth?: number;
}

export const RepoMapInputSchema: z.ZodType<RepoMapInput> = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Repository-relative path prefix to list, for example "packages/agent-core-v2". Omit to list the whole repository.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'How deep to list below the prefix: depth 1 returns the direct children, depth 2 their children, and so on. The default is 3.',
    ),
});

export interface IRepoMapTool extends AgentTool<RepoMapInput> {
  readonly _serviceBrand: undefined;
}
export const IRepoMapTool = createDecorator<IRepoMapTool>('repoMapTool');
