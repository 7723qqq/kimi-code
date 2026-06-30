import type { ToolCall } from '@moonshot-ai/kosong';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { LoopEvent } from '#/loop';
import { ToolAccesses, type ExecutableTool, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution, type ToolResult, type ToolUpdate } from '#/tool';
import { IToolExecutor, ToolExecutorService } from '#/toolExecutor';
import { IToolRegistry, ToolRegistryService } from '#/toolRegistry';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let executor: IToolExecutor;
let registry: IToolRegistry;
let events: LoopEvent[];

beforeEach(() => {
  disposables = new DisposableStore();
  events = [];
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.define(IToolRegistry, ToolRegistryService);
      reg.define(IToolExecutor, ToolExecutorService);
    },
    strict: true,
  });
  executor = ix.get(IToolExecutor);
  registry = ix.get(IToolRegistry);
});

afterEach(() => {
  disposables.dispose();
});

describe('ToolExecutorService', () => {
  it('resolves by interface and routes a successful tool call through execute', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'hi',
        stopTurn: false,
      }),
    ]);
    expect(tool.calls).toEqual([
      expect.objectContaining({
        toolCallId: 'call_echo',
        turnId: 'turn-1',
        args: { text: 'hi' },
      }),
    ]);
    expect(eventTypes()).toEqual(['tool.call', 'tool.result']);
  });

  it('records an error tool.result when the tool name is unknown', async () => {
    const results = await execute([toolCall('call_missing', 'missing', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "missing" not found',
        isError: true,
      }),
    ]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_missing'],
      results: ['call_missing'],
    });
  });

  it('records an error tool.result when args fail tool parameter validation', async () => {
    const tool = new TestTool('strict', {
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_strict', 'strict', { value: 'bad' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: expect.stringContaining('Invalid args for tool "strict"'),
        isError: true,
      }),
    ]);
    expect(tool.calls).toEqual([]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_strict'],
      results: ['call_strict'],
    });
  });

  it('onWillExecuteTool block records an error result without invoking execute', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onWillExecuteTool.register('block', async (ctx) => {
      ctx.decision = { block: true, reason: 'forbidden' };
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'forbidden',
        isError: true,
      }),
    ]);
    expect(tool.calls).toEqual([]);
  });

  it('onWillExecuteTool syntheticResult bypasses execute', async () => {
    const first = new TestTool('first');
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);
    executor.hooks.onWillExecuteTool.register('synthetic', async (ctx) => {
      if (ctx.toolCall.id !== 'call_first') return;
      ctx.decision = {
        syntheticResult: {
          output: 'synthetic',
        },
      };
    });

    const results = await execute([
      toolCall('call_first', 'first', {}),
      toolCall('call_second', 'second', {}),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ output: 'synthetic' }),
      expect.objectContaining({ output: 'second result' }),
    ]);
    expect(first.calls).toEqual([]);
    expect(second.calls).toHaveLength(1);
  });

  it('skips later tool calls after an execution requests stopBatchAfterThis', async () => {
    const first = new TestTool('first', { stopBatchAfterThis: true });
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);

    const results = await execute([
      toolCall('call_first', 'first', {}),
      toolCall('call_second', 'second', {}),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ output: 'first result', stopBatchAfterThis: true }),
      expect.objectContaining({
        output: 'Tool skipped because a previous tool call stopped the turn.',
        isError: true,
      }),
    ]);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toEqual([]);
  });

  it('writes resolveExecution description and display onto tool.call events', async () => {
    const tool = new TestTool('display', {
      description: 'Prepared display description',
      display: {
        kind: 'generic',
        summary: 'Display summary',
        detail: { value: 1 },
      },
    });
    registry.register(tool);

    await execute([toolCall('call_display', 'display', {})]);

    expect(events.find((event) => event.type === 'tool.call')).toMatchObject({
      type: 'tool.call',
      description: 'Prepared display description',
      display: {
        kind: 'generic',
        summary: 'Display summary',
        detail: { value: 1 },
      },
    });
  });

  it('captures tool execution failures as error results', async () => {
    const tool = new TestTool('fail', {
      execute: async () => {
        throw new Error('tool blew up');
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_fail', 'fail', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "fail" failed: tool blew up',
        isError: true,
      }),
    ]);
  });

  it('coerces an undefined tool return into an error result without breaking pairing', async () => {
    const tool = new TestTool('corrupt', {
      execute: async () => undefined as unknown as ExecutableToolResult,
    });
    registry.register(tool);

    const results = await execute([toolCall('call_corrupt', 'corrupt', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "corrupt" returned no result.',
        isError: true,
      }),
    ]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_corrupt'],
      results: ['call_corrupt'],
    });
  });

  it('forwards onUpdate calls as tool.progress events', async () => {
    const updates: ToolUpdate[] = [
      { kind: 'stdout', text: 'working' },
      { kind: 'progress', percent: 50 },
    ];
    const tool = new TestTool('progress', {
      execute: async (ctx) => {
        for (const update of updates) ctx.onUpdate?.(update);
        return { output: 'done' };
      },
    });
    registry.register(tool);

    await execute([toolCall('call_progress', 'progress', {})]);

    expect(events.filter((event) => event.type === 'tool.progress')).toEqual([
      { type: 'tool.progress', toolCallId: 'call_progress', update: updates[0] },
      { type: 'tool.progress', toolCallId: 'call_progress', update: updates[1] },
    ]);
  });

  it('does not start a queued conflicting tool after abort', async () => {
    const controller = new AbortController();
    const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
    const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
    registry.register(first);
    registry.register(second);

    const execution = execute(
      [toolCall('call_first', 'first', {}), toolCall('call_second', 'second', {})],
      controller.signal,
    );
    await first.started;
    controller.abort();
    const results = await execution;

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
    expect(results).toEqual([
      expect.objectContaining({ output: 'Tool "first" was aborted', isError: true }),
      expect.objectContaining({ output: 'Tool "second" was aborted', isError: true }),
    ]);
  });

  it('every tool.call still has a matching tool.result when aborted mid-batch', async () => {
    const controller = new AbortController();
    const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
    const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
    const third = new TestTool('third', { accesses: ToolAccesses.readFile('/repo/b.ts') });
    registry.register(first);
    registry.register(second);
    registry.register(third);

    const execution = execute(
      [
        toolCall('call_first', 'first', {}),
        toolCall('call_second', 'second', {}),
        toolCall('call_third', 'third', {}),
      ],
      controller.signal,
    );
    await first.started;
    controller.abort();
    await execution;

    expect(pairedToolCallIds()).toEqual({
      calls: ['call_first', 'call_second', 'call_third'],
      results: ['call_first', 'call_second', 'call_third'],
    });
  });

  it('preserves media-only image output with a text companion', async () => {
    const tool = new TestTool('image', {
      result: {
        output: [{ type: 'image_url', imageUrl: { url: 'ms://image-1', id: 'image-1' } }],
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_image', 'image', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: [
          { type: 'text', text: 'Tool returned non-text content.' },
          { type: 'image_url', imageUrl: { url: 'ms://image-1', id: 'image-1' } },
        ],
      }),
    ]);
  });

  it('onDidExecuteTool failures replace the raw output with a hook error', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onDidExecuteTool.register('fail-finalize', async () => {
      throw new Error('finalize crashed');
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'raw output' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'onDidExecuteTool hook failed for "echo": finalize crashed',
        isError: true,
      }),
    ]);
    const toolResultEvents = events.filter((event) => event.type === 'tool.result');
    expect(JSON.stringify(toolResultEvents)).not.toContain('raw output');
  });

  it('onDidExecuteTool can stop the turn without marking the tool failed', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onDidExecuteTool.register('stop', async (ctx) => {
      ctx.stopTurn = true;
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'done' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'done',
        stopTurn: true,
      }),
    ]);
  });
});

function execute(calls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
  return executor.execute(calls, {
    turnId: 'turn-1',
    stepNumber: 1,
    stepUuid: 'step-1',
    signal,
    dispatchEvent: async (event) => {
      events.push(event);
    },
    onProgress: (toolCallId, update) => {
      events.push({ type: 'tool.progress', toolCallId, update });
    },
  });
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function eventTypes(): LoopEvent['type'][] {
  return events.map((event) => event.type);
}

function pairedToolCallIds(): { readonly calls: string[]; readonly results: string[] } {
  return {
    calls: events
      .filter((event): event is Extract<LoopEvent, { type: 'tool.call' }> => event.type === 'tool.call')
      .map((event) => event.toolCallId),
    results: events
      .filter((event): event is Extract<LoopEvent, { type: 'tool.result' }> => event.type === 'tool.result')
      .map((event) => event.toolCallId),
  };
}

class TestTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Test tool.';
  readonly parameters: Record<string, unknown>;
  readonly calls: Array<ExecutableToolContext & { readonly args: Record<string, unknown> }> = [];

  constructor(
    readonly name: string,
    private readonly options: {
      readonly parameters?: Record<string, unknown>;
      readonly accesses?: ToolAccesses;
      readonly stopBatchAfterThis?: boolean;
      readonly description?: string;
      readonly display?: ToolInputDisplay;
      readonly result?: ExecutableToolResult;
      readonly execute?: (
        ctx: ExecutableToolContext,
        args: Record<string, unknown>,
      ) => Promise<ExecutableToolResult>;
    } = {},
  ) {
    this.parameters = options.parameters ?? { type: 'object', additionalProperties: true };
  }

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: this.options.accesses,
      stopBatchAfterThis: this.options.stopBatchAfterThis,
      description: this.options.description,
      display: this.options.display,
      execute: async (ctx) => {
        this.calls.push({ ...ctx, args });
        if (this.options.execute !== undefined) {
          return this.options.execute(ctx, args);
        }
        return this.options.result ?? { output: String(args['text'] ?? `${this.name} result`) };
      },
    };
  }
}

class ControlledTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Controlled tool.';
  readonly parameters = { type: 'object', additionalProperties: true };
  readonly calls: ExecutableToolContext[] = [];
  readonly started: Promise<void>;
  private resolveStarted: () => void = () => {};

  constructor(
    readonly name: string,
    private readonly accesses: ToolAccesses,
  ) {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: this.accesses,
      execute: async (ctx) => {
        this.calls.push(ctx);
        this.resolveStarted();
        return new Promise<ExecutableToolResult>((resolve, reject) => {
          const onAbort = (): void => {
            ctx.signal.removeEventListener('abort', onAbort);
            const error = new Error(`${this.name} aborted`);
            error.name = 'AbortError';
            reject(error);
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
          setTimeout(() => {
            ctx.signal.removeEventListener('abort', onAbort);
            resolve({ output: `${this.name} result` });
          }, 50);
        });
      },
    };
  }
}
