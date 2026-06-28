import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { ExecutableTool, ToolExecution } from '#/tool';
import { IToolExecutor, ToolExecutorService } from '#/toolExecutor';
import type { ToolCall } from '#/toolRegistry';
import { IToolRegistry, ToolRegistryService } from '#/toolRegistry';

const echoTool: ExecutableTool = {
  name: 'echo',
  description: 'echoes its input',
  parameters: {},
  resolveExecution: (input) => ({
    approvalRule: 'echo(*)',
    execute: () => Promise.resolve({ output: JSON.stringify(input) }),
  }),
};

const userTool: ExecutableTool = {
  name: 'user-tool',
  description: 'a user-registered tool',
  parameters: {},
  resolveExecution: () => ({
    approvalRule: 'user-tool(*)',
    execute: () => Promise.resolve({ output: 'user' }),
  }),
};

const mcpTool: ExecutableTool = {
  name: 'mcp-tool',
  description: 'an mcp tool',
  parameters: {},
  resolveExecution: () => ({
    approvalRule: 'mcp-tool(*)',
    execute: () => Promise.resolve({ output: 'mcp' }),
  }),
};

describe('ToolRegistryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IToolRegistry, new SyncDescriptor(ToolRegistryService));
  });
  afterEach(() => disposables.dispose());

  it('registers and resolves a tool by name', () => {
    const reg = ix.get(IToolRegistry);
    reg.register(echoTool);
    expect(reg.resolve('echo')).toBe(echoTool);
    expect(reg.resolve('missing')).toBeUndefined();
  });

  it('records the registration source on list()', () => {
    const reg = ix.get(IToolRegistry);
    reg.register(userTool, { source: 'user' });
    expect(reg.list().find((tool) => tool.name === 'user-tool')?.source).toBe('user');
  });

  it('list() aggregates builtin, user, and mcp tools sorted by name', () => {
    const reg = ix.get(IToolRegistry);
    reg.register(echoTool);
    reg.register(userTool, { source: 'user' });
    reg.register(mcpTool, { source: 'mcp' });
    expect(reg.list().map((tool) => tool.name)).toEqual([
      'echo',
      'mcp-tool',
      'user-tool',
    ]);
  });
});

describe('ToolExecutorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IToolRegistry, new SyncDescriptor(ToolRegistryService));
    ix.set(IToolExecutor, new SyncDescriptor(ToolExecutorService));
  });
  afterEach(() => disposables.dispose());

  function call(name: string, args: unknown): ToolCall {
    return { id: `call-${name}`, name, arguments: args };
  }

  it('executes a tool and returns its normalized output', async () => {
    ix.get(IToolRegistry).register(echoTool);
    const executor = ix.get(IToolExecutor);
    const [result] = await executor.execute([call('echo', { msg: 'hi' })]);
    expect(result).toMatchObject({ output: '{"msg":"hi"}' });
    expect(result?.isError).toBeUndefined();
  });

  it('returns an error result when execution rejects', async () => {
    const boomTool: ExecutableTool = {
      name: 'boom',
      description: 'rejects',
      parameters: {},
      resolveExecution: () => ({
        approvalRule: 'boom(*)',
        execute: () => Promise.reject(new Error('kaboom')),
      }),
    };
    ix.get(IToolRegistry).register(boomTool);
    const executor = ix.get(IToolExecutor);
    const [result] = await executor.execute([call('boom', {})]);
    expect(result).toMatchObject({
      output: 'Tool "boom" failed: kaboom',
      isError: true,
    });
  });

  it('returns an aborted result when the signal is already aborted', async () => {
    ix.get(IToolRegistry).register(echoTool);
    const executor = ix.get(IToolExecutor);
    const controller = new AbortController();
    controller.abort();
    const [result] = await executor.execute([call('echo', {})], {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      output: 'Tool "echo" was aborted',
      isError: true,
    });
  });
});
