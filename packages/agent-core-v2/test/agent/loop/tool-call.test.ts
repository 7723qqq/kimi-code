/**
 * `loop` domain — tool-call invariants observed end-to-end.
 *
 * Ported from v1 `packages/agent-core/test/loop/tool-call.e2e.test.ts` (plus
 * the abnormal-step-end block). The loop promises that every provider tool
 * call produces exactly one matching `tool.result`, even on the rejected /
 * error paths (tool not found, schema rejected, execute throws), and that
 * the results are fed back into the next LLM request.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentProfileService } from '#/index';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import {
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';

import { createLoopTestAgent, makeEchoTool, nextTurnMessage, registerTool } from './helpers';

function rpcEvents(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

function expectTextOutput(output: unknown): string {
  expect(typeof output).toBe('string');
  return output as string;
}

/** One-shot tool factory so each test controls the failure mode. */
function makeTool(
  name: string,
  options: {
    readonly parameters?: Record<string, unknown>;
    readonly onExecute?: (ctx: ExecutableToolContext) => Promise<unknown> | unknown;
    readonly resolveExecution?: () => ToolExecution | Promise<ToolExecution>;
  } = {},
): ExecutableTool<unknown> {
  return {
    name,
    description: `Test tool ${name}.`,
    parameters: options.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    resolveExecution: (input): ToolExecution | Promise<ToolExecution> => {
      if (options.resolveExecution !== undefined) return options.resolveExecution();
      return {
        approvalRule: name,
        execute: async (ctx): Promise<ExecutableToolResult> =>
          (await options.onExecute?.(ctx)) as ExecutableToolResult,
      };
    },
  };
}

describe('Agent loop — tool-call behaviour', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('routes a successful tool call through execute and feeds the result back', async () => {
    const echo = makeEchoTool();
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'text', text: 'I will call echo.' },
      { type: 'function', id: 'tc-1', name: 'echo', arguments: '{"text":"hi"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('echo hi')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 2 });

    expect(echo.calls).toHaveLength(1);
    expect(echo.calls[0]).toMatchObject({ id: 'tc-1', args: { text: 'hi' } });
    // tool.call.started and tool.result are paired for the same id.
    expect(rpcEvents(ctx, 'tool.call.started').map((e) => e['toolCallId'])).toEqual(['tc-1']);
    expect(rpcEvents(ctx, 'tool.result').map((e) => e['toolCallId'])).toEqual(['tc-1']);
    expect(rpcEvents(ctx, 'tool.result')[0]).toMatchObject({
      output: 'hi',
      isError: undefined,
    });

    // The next LLM input carries the assistant call plus the tool result.
    const inputs = ctx.llmInputs();
    const history = inputs.inputs.at(-1)!.history;
    expect(history.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'tc-1', name: 'echo' }],
    });
    expect(history.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'tc-1',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('records an error tool.result when the tool name is unknown', async () => {
    ctx.mockNextResponse(
      { type: 'function', id: 'tc-1', name: 'ghost', arguments: '{"x":1}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run ghost')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const results = rpcEvents(ctx, 'tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'tc-1', isError: true });
    expect(expectTextOutput(results[0]?.['output']).toLowerCase()).toContain('not found');
  });

  it('records an error tool.result when args fail tool parameter validation', async () => {
    let executed = false;
    const strict = makeTool('strict', {
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
      onExecute: () => {
        executed = true;
        return { output: 'ok' };
      },
    });
    registerTool(ctx, strict);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-1', name: 'strict', arguments: '{"value":"NOT_A_NUMBER"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('strict call')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    expect(executed).toBe(false); // execute was NOT called
    const results = rpcEvents(ctx, 'tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(expectTextOutput(results[0]?.['output']).toLowerCase()).toContain('invalid args');
  });

  it('captures tool execution failures as error results', async () => {
    const failing = makeTool('fail', {
      onExecute: () => {
        throw new Error('boom');
      },
    });
    registerTool(ctx, failing);

    ctx.mockNextResponse({ type: 'function', id: 'tc-1', name: 'fail', arguments: '{}' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('fail call')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const results = rpcEvents(ctx, 'tool.result');
    expect(results[0]).toMatchObject({ isError: true });
    expect(expectTextOutput(results[0]?.['output']).toLowerCase()).toContain('boom');
  });

  it('coerces an undefined tool return into an error tool.result', async () => {
    const undef = makeTool('undef', {
      onExecute: () => undefined,
    });
    registerTool(ctx, undef);

    ctx.mockNextResponse({ type: 'function', id: 'tc-U', name: 'undef', arguments: '{}' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('undef call')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const results = rpcEvents(ctx, 'tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(expectTextOutput(results[0]?.['output'])).toContain('returned no result');
  });

  it('skips later tool calls after a successful stop-turn result', async () => {
    const stop = makeTool('stop-success', {
      // v2 declares batch-skip intent up front; the stopTurn result then
      // ends the turn after the (skipped) batch completes.
      resolveExecution: () => ({
        stopBatchAfterThis: true,
        approvalRule: 'stop-success',
        execute: async () => ({ output: 'stopped', stopTurn: true }),
      }),
    });
    const echo = makeEchoTool();
    registerTool(ctx, stop);
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-stop', name: 'stop-success', arguments: '{}' },
      { type: 'function', id: 'tc-echo', name: 'echo', arguments: '{"text":"must not run"}' },
    );

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('stop now')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 1 });
    ctx.llmInputs();

    expect(echo.calls).toHaveLength(0);
    // Both calls still get paired results; the second is a synthetic skip.
    // (tool.result order is completion order in v2, not provider order.)
    expect(rpcEvents(ctx, 'tool.call.started').map((e) => e['toolCallId'])).toEqual([
      'tc-stop',
      'tc-echo',
    ]);
    const results = rpcEvents(ctx, 'tool.result');
    expect(
      results.map((e) => e['toolCallId']).toSorted(),
    ).toEqual(['tc-echo', 'tc-stop']);
    expect(results.find((e) => e['toolCallId'] === 'tc-stop')).toMatchObject({
      output: 'stopped',
      isError: undefined,
    });
    expect(results.find((e) => e['toolCallId'] === 'tc-echo')).toMatchObject({ isError: true });
    expect(
      expectTextOutput(results.find((e) => e['toolCallId'] === 'tc-echo')?.['output']),
    ).toContain('skipped');
  });

  it('keeps every tool.call paired when one parallel tool returns a corrupt result', async () => {
    const undef = makeTool('undef', {
      onExecute: () => undefined,
    });
    const echo = makeEchoTool();
    registerTool(ctx, undef);
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-U', name: 'undef', arguments: '{}' },
      { type: 'function', id: 'tc-E1', name: 'echo', arguments: '{"text":"a"}' },
      { type: 'function', id: 'tc-E2', name: 'echo', arguments: '{"text":"b"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('parallel')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const callIds = rpcEvents(ctx, 'tool.call.started')
      .map((e) => e['toolCallId'])
      .toSorted();
    const resultIds = rpcEvents(ctx, 'tool.result')
      .map((e) => e['toolCallId'])
      .toSorted();
    expect(callIds).toEqual(['tc-E1', 'tc-E2', 'tc-U']);
    expect(resultIds).toEqual(callIds);
    const results = rpcEvents(ctx, 'tool.result');
    expect(results.find((r) => r['toolCallId'] === 'tc-U')).toMatchObject({ isError: true });
    expect(results.find((r) => r['toolCallId'] === 'tc-E1')?.['isError']).not.toBe(true);
  });

  it('forwards onUpdate calls as tool.progress events', async () => {
    const progress = makeTool('progress', {
      onExecute: ({ onUpdate }) => {
        onUpdate?.({ kind: 'stdout', text: 'a' });
        onUpdate?.({ kind: 'progress', percent: 25 });
        onUpdate?.({ kind: 'progress', percent: 75 });
        return { output: 'done' };
      },
    });
    registerTool(ctx, progress);

    ctx.mockNextResponse({ type: 'function', id: 'tc-1', name: 'progress', arguments: '{}' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('progress')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const progressEvents = rpcEvents(ctx, 'tool.progress');
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.every((e) => e['toolCallId'] === 'tc-1')).toBe(true);
    expect(progressEvents.map((e) => (e['update'] as { kind?: string }).kind)).toEqual([
      'stdout',
      'progress',
      'progress',
    ]);
  });

  it('still executes requested tool calls when the provider ends the step truncated', async () => {
    const echo = makeEchoTool();
    registerTool(ctx, echo);

    ctx.mockNextProviderResponse({
      parts: [
        { type: 'text', text: 'partial answer' },
        { type: 'function', id: 'tc-max', name: 'echo', arguments: '{"text":"hi"}' },
      ],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('truncated')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 2 });

    // Unlike v1, v2 still executes the tool call so the exchange stays
    // wire-valid, then continues the turn.
    expect(echo.calls).toHaveLength(1);
    expect(rpcEvents(ctx, 'tool.call.started').map((e) => e['toolCallId'])).toEqual(['tc-max']);
    expect(rpcEvents(ctx, 'tool.result').map((e) => e['toolCallId'])).toEqual(['tc-max']);
  });
});
