import type { ToolCall } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IProfileService } from '#/index';
import { ILoopService } from '#/loop';

import { createTestAgent, type TestAgentContext } from '../harness';

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: ILoopService;
  let profile: IProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    loop = ctx.get(ILoopService);
    profile = ctx.get(IProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('resolves the loop service from the agent scope by interface', () => {
    expect(loop).toBeDefined();
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] tools.set_active_tools   { "names": [], "time": "<time>" }
    [wire] context.splice           { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] turn.launch              { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
    [emit] turn.step.started        { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] thinking.delta           { "turnId": 0, "delta": "<think-1>" }
    [wire] usage.record             { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated     { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] assistant.delta          { "turnId": 0, "delta": "<text-1>" }
    [wire] context.splice           { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] context.splice           { "start": 1, "deleteCount": 1, "messages": [ { "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" }, { "type": "text", "text": "<text-1>" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] context_size.measured    { "length": 2, "tokens": 11, "time": "<time>" }
    [emit] agent.status.updated     { "contextTokens": 11, "maxContextTokens": 1000000, "contextUsage": 0.000011 }
    [emit] turn.step.completed      { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [emit] turn.ended               { "turnId": 0, "reason": "completed" }
  `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  });

  it('forwards provider finish diagnostics on filtered steps', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] context.splice          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] turn.launch             { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started            { "turnId": 0, "origin": { "kind": "user" } }
    [emit] turn.step.started       { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] assistant.delta         { "turnId": 0, "delta": "blocked" }
    [wire] context.splice          { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "blocked" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] context_size.measured   { "length": 2, "tokens": 8, "time": "<time>" }
    [emit] agent.status.updated    { "contextTokens": 8, "maxContextTokens": 1000000, "contextUsage": 0.000008 }
    [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "filtered", "providerFinishReason": "filtered", "rawFinishReason": "content_filter" }
    [emit] turn.ended              { "turnId": 0, "reason": "filtered" }
  `);

    const rpcStepEnd = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(rpcStepEnd?.args).toMatchObject({
      finishReason: 'filtered',
      providerFinishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    profile.update({ activeToolNames: ['Lookup'] });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
    [wire] tools.register_user_tool   { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
    [wire] context.splice             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] turn.launch                { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started               { "turnId": 0, "origin": { "kind": "user" } }
    [emit] turn.step.started          { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] assistant.delta            { "turnId": 0, "delta": "I will look it up." }
    [wire] usage.record               { "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated       { "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] tool.call.delta            { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
    [wire] context.splice             { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
    [emit] requestApproval            { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }
  `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Lookup
    messages:
      user: text "Look up moon"
  `);

    const toolCallEvents = ctx.untilToolCall({
      content: 'lookup-result',
      output: 'lookup-result',
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    await toolCallEvents;
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] context.splice          { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "lookup-result" } ], "toolCalls": [], "toolCallId": "call_lookup" } ], "time": "<time>" }
    [emit] tool.result             { "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
    [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
    [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
    [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] assistant.delta         { "turnId": 0, "delta": "The lookup result is lookup-result." }
    [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is lookup-result." } ], "toolCalls": [] } ], "time": "<time>" }
    [wire] context_size.measured   { "length": 4, "tokens": 37, "time": "<time>" }
    [emit] agent.status.updated    { "contextTokens": 37, "maxContextTokens": 1000000, "contextUsage": 0.000037 }
    [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [emit] turn.ended              { "turnId": 0, "reason": "completed" }
  `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
      tool[call_lookup]: text "lookup-result"
  `);
  });
});
