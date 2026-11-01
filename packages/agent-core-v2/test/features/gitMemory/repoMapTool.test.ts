import { describe, expect, it } from 'bun:test';

import type { IGitMemoryService } from '#/features/gitMemory/gitMemoryService';
import { REPO_MAP_EMPTY_OUTPUT, RepoMapTool } from '#/features/gitMemory/tools/repoMapTool';
import type { ExecutableToolContext } from '#/tool/toolContract';

const CONTEXT: ExecutableToolContext = {
  turnId: 1,
  toolCallId: 'call-1',
  signal: new AbortController().signal,
};

interface Recorded {
  path: string | undefined;
  depth: number;
}

function service(output: string, recorded: Recorded[]): IGitMemoryService {
  return {
    _serviceBrand: undefined,
    repoBlock: async () => '',
    signalBlock: async () => '',
    fileBlock: async () => '',
    repoMap: async (path: string | undefined, depth: number) => {
      recorded.push({ path, depth });
      return output;
    },
  } as unknown as IGitMemoryService;
}

async function run(tool: RepoMapTool, args: { path?: string; depth?: number }): Promise<string> {
  const execution = tool.resolveExecution(args);
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  const result = await execution.execute(CONTEXT);
  return typeof result.output === 'string' ? result.output : '';
}

describe('repo map tool', () => {
  it('returns the tracked paths of the requested subtree', async () => {
    const recorded: Recorded[] = [];
    const tool = new RepoMapTool(service('packages\npackages/agent-core-v2\n', recorded));
    const output = await run(tool, { path: 'packages', depth: 2 });
    expect(output).toBe('packages\npackages/agent-core-v2\n');
    expect(recorded).toEqual([{ path: 'packages', depth: 2 }]);
  });

  it('defaults to depth 3 and the whole repository', async () => {
    const recorded: Recorded[] = [];
    const tool = new RepoMapTool(service('apps\n', recorded));
    await run(tool, {});
    expect(recorded).toEqual([{ path: undefined, depth: 3 }]);
  });

  it('reports an empty listing instead of returning nothing', async () => {
    const recorded: Recorded[] = [];
    const tool = new RepoMapTool(service('', recorded));
    expect(await run(tool, {})).toBe(REPO_MAP_EMPTY_OUTPUT);
  });

  it('describes itself and exposes its parameters', () => {
    const tool = new RepoMapTool(service('', []));
    expect(tool.name).toBe('RepoMap');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
  });
});
