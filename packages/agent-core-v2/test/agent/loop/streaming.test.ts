/**
 * `loop` domain — streaming delta routing.
 *
 * Ported from v1 `packages/agent-core/test/loop/streaming.e2e.test.ts`.
 * Provider parts are translated into live delta events (`assistant.delta`,
 * `thinking.delta`, `tool.call.delta`) and the completed content is
 * persisted into the context history.
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

describe('Agent loop — streaming callbacks', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('routes text parts into assistant.delta events', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const deltas = rpcEvents(ctx, 'assistant.delta').map((e) => e['delta']);
    expect(deltas).toEqual(['hel', 'lo']);
  });

  it('routes think parts into thinking.delta events', async () => {
    ctx.mockNextResponse({ type: 'think', think: 'ponder' }, { type: 'text', text: 'answer' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const thinks = rpcEvents(ctx, 'thinking.delta').map((e) => e['delta']);
    expect(thinks).toEqual(['ponder']);
  });

  it('routes function parts into tool.call.delta events', async () => {
    const echo = makeEchoTool();
    registerTool(ctx, echo);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-1', name: 'echo', arguments: '{"text":"hi"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const deltas = rpcEvents(ctx, 'tool.call.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      toolCallId: 'tc-1',
      name: 'echo',
      argumentsPart: '{"text":"hi"}',
    });
  });

  it('persists streamed text parts into the context history in order', async () => {
    ctx.mockNextResponse(
      { type: 'think', think: 'pondering' },
      { type: 'text', text: 'first' },
      { type: 'text', text: ' second' },
    );

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    const history = ctx.contextData().history;
    const assistant = history.find((message) => message.role === 'assistant');
    // Text parts merge in stream order; the think part is persisted alongside.
    expect(assistant?.content).toEqual([
      { type: 'think', think: 'pondering' },
      { type: 'text', text: 'first second' },
    ]);
  });
});
