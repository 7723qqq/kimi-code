import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { GIT_MEMORY_FLAG_ID } from '#/features/gitMemory/flag';
import { IGitMemoryService } from '#/features/gitMemory/gitMemoryService';
import { GIT_MEMORY_TREE_DEPTH } from '#/features/gitMemory/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  IRepoMapTool,
  REPO_MAP_TOOL_NAME,
  RepoMapInputSchema,
  type RepoMapInput,
} from './repo-map';
import DESCRIPTION from './repo-map.md?raw';

export const REPO_MAP_EMPTY_OUTPUT =
  'No tracked paths matched. Check the path prefix against the repository layout, or raise the depth.';

export class RepoMapTool implements IRepoMapTool {
  declare readonly _serviceBrand: undefined;
  readonly name = REPO_MAP_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RepoMapInputSchema);

  constructor(@IGitMemoryService private readonly gitMemory: IGitMemoryService) {}

  resolveExecution(args: RepoMapInput): ToolExecution {
    const path = args.path;
    const depth = args.depth ?? GIT_MEMORY_TREE_DEPTH;
    return {
      accesses: ToolAccesses.none(),
      description: 'Reading the repository map',
      approvalRule: this.name,
      execute: async () => {
        const output = await this.gitMemory.repoMap(path, depth);
        if (output.length === 0) {
          return { isError: true, output: REPO_MAP_EMPTY_OUTPUT };
        }
        return { output };
      },
    };
  }
}

registerAgentToolService(IRepoMapTool, RepoMapTool, {
  name: REPO_MAP_TOOL_NAME,
  domain: 'gitMemory',
  when: (accessor) => accessor.get(IFlagService).enabled(GIT_MEMORY_FLAG_ID),
});
