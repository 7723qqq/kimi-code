import { describe, expect, it, mock } from 'bun:test';

import type {
  IAgentToolExecutorService,
  ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import { createMachineTools } from '#/agent/loop/machine/tools';
import type { ToolCall } from '#human/llm/message';
import type { ToolExecuteInput } from '#human/tool/executor';
import type { ToolInfo } from '#/tool/toolContract';

function call(id: string, name: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function input(toolCall: ToolCall): ToolExecuteInput {
  return { toolCall, signal: new AbortController().signal };
}

function createRecordingExecutor(): {
  toolExecutor: IAgentToolExecutorService;
  batches: string[][];
} {
  const batches: string[][] = [];
  const toolExecutor = {
    execute: async function* (calls: ToolCall[]) {
      batches.push(calls.map((toolCall) => toolCall.id));
      for (const toolCall of calls) {
        yield {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: { output: `ok:${toolCall.id}` },
          durationMs: 7,
        } satisfies ToolExecutionResult;
      }
    },
  } as unknown as IAgentToolExecutorService;
  return { toolExecutor, batches };
}

const toolInfos: ToolInfo[] = [
  { name: 'Bash', description: 'run a command', source: 'builtin' },
  { name: 'Read', description: 'read a file', source: 'builtin' },
];

describe('createMachineTools duplicate tool call ids', () => {
  it('runs one batch per unique id and settles the superseded pending entry', async () => {
    const { toolExecutor, batches } = createRecordingExecutor();
    const onBatchError = mock();
    const onToolResult = mock();
    const tools = createMachineTools({
      toolExecutor,
      toolInfos: () => toolInfos,
      turnId: () => 1,
      onBatchError,
      onToolResult,
    });
    tools.sync();
    const bash = tools.tools.find((tool) => tool.name === 'Bash');
    const read = tools.tools.find((tool) => tool.name === 'Read');
    if (bash === undefined || read === undefined) throw new Error('missing tool definitions');

    tools.beginBatch([call('t1', 'Bash'), call('t1', 'Bash'), call('t2', 'Read')]);
    const first = bash.execute(input(call('t1', 'Bash')));
    const second = bash.execute(input(call('t1', 'Bash')));
    const third = read.execute(input(call('t2', 'Read')));

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

    expect(batches).toEqual([['t1', 't2']]);
    expect(onBatchError).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith('t1', { output: 'ok:t1' }, 7);
    expect(onToolResult).toHaveBeenCalledWith('t2', { output: 'ok:t2' }, 7);
    expect(firstResult.isError).toBe(true);
    expect(secondResult.content).toEqual([{ type: 'text', text: 'ok:t1' }]);
    expect(secondResult.isError).toBeUndefined();
    expect(thirdResult.content).toEqual([{ type: 'text', text: 'ok:t2' }]);
  });

  it('settles pending calls that the replaced expected set can no longer satisfy', async () => {
    const { toolExecutor, batches } = createRecordingExecutor();
    const onBatchError = mock();
    const tools = createMachineTools({
      toolExecutor,
      toolInfos: () => toolInfos,
      turnId: () => 1,
      onBatchError,
    });
    tools.sync();
    const bash = tools.tools.find((tool) => tool.name === 'Bash');
    if (bash === undefined) throw new Error('missing tool definition');

    tools.beginBatch([call('t1', 'Bash'), call('t2', 'Bash')]);
    const stranded = bash.execute(input(call('t1', 'Bash')));

    tools.beginBatch([call('t3', 'Bash')]);
    const settled = await stranded;

    expect(settled.isError).toBe(true);
    expect(settled.content).toEqual([
      { type: 'text', text: 'Tool "Bash" aborted before execution.' },
    ]);
    expect(batches).toEqual([]);

    const next = bash.execute(input(call('t3', 'Bash')));
    await expect(next).resolves.toEqual({ content: [{ type: 'text', text: 'ok:t3' }] });
    expect(batches).toEqual([['t3']]);
    expect(onBatchError).not.toHaveBeenCalled();
  });

  it('reports executor failures through onBatchError and settles every pending call', async () => {
    const toolExecutor = {
      execute: (): AsyncIterable<ToolExecutionResult> => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error('executor exploded')) };
        },
      }),
    } as unknown as IAgentToolExecutorService;
    const onBatchError = mock();
    const tools = createMachineTools({
      toolExecutor,
      toolInfos: () => toolInfos,
      turnId: () => 1,
      onBatchError,
    });
    tools.sync();
    const bash = tools.tools.find((tool) => tool.name === 'Bash');
    const read = tools.tools.find((tool) => tool.name === 'Read');
    if (bash === undefined || read === undefined) throw new Error('missing tool definitions');

    tools.beginBatch([call('t1', 'Bash'), call('t2', 'Read')]);
    const [firstResult, secondResult] = await Promise.all([
      bash.execute(input(call('t1', 'Bash'))),
      read.execute(input(call('t2', 'Read'))),
    ]);

    expect(onBatchError).toHaveBeenCalledTimes(1);
    expect(firstResult.isError).toBe(true);
    expect(secondResult.isError).toBe(true);
  });
});
