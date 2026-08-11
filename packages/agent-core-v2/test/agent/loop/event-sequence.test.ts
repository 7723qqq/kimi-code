/**
 * `loop` domain — live event sequence and wire-record ordering.
 *
 * Ported from v1 `packages/agent-core/test/loop/events.e2e.test.ts`. The
 * loop must emit the documented milestone sequence for a tool-bearing turn
 * and keep transcript (`context.append_loop_event`) records ordered:
 * `step.begin` → `tool.call` → `tool.result` → `step.end`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { permissionModeServices, type TestAgentContext } from '../../harness';

import { createLoopTestAgent, makeEchoTool, nextTurnMessage, registerTool } from './helpers';

function rpcEvents(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

/** Indexes of `[wire] context.append_loop_event` records of a given type. */
function loopEventIndexes(ctx: TestAgentContext, type: string): number[] {
  const indexes: number[] = [];
  ctx.allEvents.forEach((entry, index) => {
    if (
      entry.type === '[wire]' &&
      entry.event === 'context.append_loop_event' &&
      (entry.args as { event?: { type?: string } }).event?.type === type
    ) {
      indexes.push(index);
    }
  });
  return indexes;
}

describe('Agent loop — event sequences', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('emits the documented milestone sequence for one tool-bearing turn', async () => {
    const echo = makeEchoTool();
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'text', text: 'calling' },
      { type: 'function', id: 'tc-1', name: 'echo', arguments: '{"text":"hi"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });
    ctx.llmInputs();

    // [rpc] milestone ordering: step 1 open → tool call → tool result →
    // step 1 close → step 2 open → step 2 close.
    const order: string[] = [];
    for (const [index, entry] of ctx.allEvents.entries()) {
      if (entry.type !== '[rpc]') continue;
      if (entry.event === 'turn.step.started') order.push(`step.started:${String(index)}`);
      if (entry.event === 'tool.call.started') order.push(`tool.call:${String(index)}`);
      if (entry.event === 'tool.result') order.push(`tool.result:${String(index)}`);
      if (entry.event === 'turn.step.completed') order.push(`step.completed:${String(index)}`);
      if (entry.event === 'turn.ended') order.push(`turn.ended:${String(index)}`);
    }
    expect(order.map((entry) => entry.split(':')[0])).toEqual([
      'step.started',
      'tool.call',
      'tool.result',
      'step.completed',
      'step.started',
      'step.completed',
      'turn.ended',
    ]);

    // [wire] transcript ordering: step.begin before tool.call before
    // tool.result before step.end.
    const begin = loopEventIndexes(ctx, 'step.begin');
    const toolCall = loopEventIndexes(ctx, 'tool.call');
    const toolResult = loopEventIndexes(ctx, 'tool.result');
    const stepEnd = loopEventIndexes(ctx, 'step.end');
    expect(begin).toHaveLength(2);
    expect(stepEnd).toHaveLength(2);
    expect(begin[0]!).toBeLessThan(toolCall[0]!);
    expect(toolCall[0]!).toBeLessThan(toolResult[0]!);
    expect(toolResult[0]!).toBeLessThan(stepEnd[0]!);
    expect(stepEnd[0]!).toBeLessThan(begin[1]!);
    expect(begin[1]!).toBeLessThan(stepEnd[1]!);
  });

  it('emits only step events for a turn with no tool calls', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'just text' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('text')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    expect(rpcEvents(ctx, 'tool.call.started')).toHaveLength(0);
    expect(rpcEvents(ctx, 'tool.result')).toHaveLength(0);
    expect(rpcEvents(ctx, 'turn.step.started')).toHaveLength(1);
    expect(rpcEvents(ctx, 'turn.step.completed')).toHaveLength(1);
    expect(loopEventIndexes(ctx, 'step.begin')).toHaveLength(1);
    expect(loopEventIndexes(ctx, 'step.end')).toHaveLength(1);
  });

  it('carries the documented payload fields on tool events', async () => {
    const echo = makeEchoTool();
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-99', name: 'echo', arguments: '{"text":"hi"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const started = rpcEvents(ctx, 'tool.call.started')[0];
    expect(started).toMatchObject({
      toolCallId: 'tc-99',
      name: 'echo',
      args: { text: 'hi' },
    });
    const result = rpcEvents(ctx, 'tool.result')[0];
    expect(result).toMatchObject({ toolCallId: 'tc-99' });
    expect(typeof result?.['output']).toBe('string');
  });

  it('records the provider response id on step.end transcript records', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'ok' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const stepEndRecord = ctx.allEvents.find(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'step.end',
    );
    expect(stepEndRecord).toBeDefined();
    expect((stepEndRecord?.args as { event?: { messageId?: string } }).event?.messageId).toBe(
      'mock-1',
    );
  });
});
