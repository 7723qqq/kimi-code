import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { Message, ToolCall } from '#/kosong/contract/message';
import type { ExecutableTool } from '#/tool/toolContract';

import { permissionModeServices, createTestAgent } from '../../harness/agent';
import type { GenerateCall } from '../../harness/snapshots';

function assertPrefixStable(calls: readonly GenerateCall[]): void {
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < calls.length; i += 1) {
    const prev = calls[i - 1]!.history;
    const curr = calls[i]!.history;
    expect(curr.length, `request ${i} must not shrink history`).toBeGreaterThanOrEqual(prev.length);
    expect(
      curr.slice(0, prev.length),
      `request ${i} must re-send the previous request's history unchanged`,
    ).toEqual(prev);
  }
  for (let i = 1; i < calls.length; i += 1) {
    expect(calls[i]!.systemPrompt, `request ${i} system prompt drift`).toBe(calls[0]!.systemPrompt);
    expect(calls[i]!.tools, `request ${i} tools drift`).toEqual(calls[0]!.tools);
  }
}

const lookupCall = (n: number): ToolCall => ({
  type: 'function',
  id: `call_lookup_${n}`,
  name: 'Lookup',
  arguments: `{"query":"moon-${n}"}`,
});

const lookupTool: ExecutableTool<{ query: string }> = {
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
  resolveExecution: () => ({
    approvalRule: 'Lookup',
    execute: async () => ({ output: 'lookup-result' }),
  }),
};

describe('cache prefix stability', () => {
  it('keeps the prefix stable across plain multi-turn dialogue', async () => {
    const ctx = createTestAgent(permissionModeServices('yolo'));
    const profile = ctx.get(IAgentProfileService);
    profile.update({ activeToolNames: [] });

    for (let turn = 1; turn <= 4; turn += 1) {
      ctx.mockNextResponse({ type: 'text', text: `answer-${turn}` });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: `question-${turn}` }] });
      await ctx.untilTurnEnd();
    }

    assertPrefixStable(ctx.llmCalls);
  });

  it('keeps the prefix stable across a multi-step tool loop', async () => {
    const ctx = createTestAgent(permissionModeServices('yolo'));
    const profile = ctx.get(IAgentProfileService);
    ctx.get(IAgentToolRegistryService).register(lookupTool);
    profile.update({ activeToolNames: ['Lookup'] });

    ctx.mockNextResponse({ type: 'text', text: 'checking' }, lookupCall(1));
    ctx.mockNextResponse({ type: 'text', text: 'checking again' }, lookupCall(2));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon' }] });
    await ctx.untilTurnEnd();

    assertPrefixStable(ctx.llmCalls);
    for (const call of ctx.llmCalls) {
      for (const message of call.history) {
        expect(message.role, 'mid-history system injection is forbidden').not.toBe('system');
      }
    }
  });

  it('keeps the prefix stable after compaction (summary + kept tail)', async () => {
    const ctx = createTestAgent(permissionModeServices('yolo'));
    const profile = ctx.get(IAgentProfileService);
    const memory = ctx.get(IAgentContextMemoryService);
    profile.update({ activeToolNames: [] });

    for (let turn = 1; turn <= 3; turn += 1) {
      ctx.mockNextResponse({ type: 'text', text: `answer-${turn}` });
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: `question-${turn} ` + 'x'.repeat(300) }],
      });
      await ctx.untilTurnEnd();
    }
    const callsBefore = ctx.llmCalls.length;

    const historyLenBefore = memory.get().length;
    memory.applyCompaction({
      summary: 'summary of earlier turns',
      compactedCount: memory.get().length,
      tokensBefore: 10_000,
      summaryOutputTokens: 20,
    });
    expect(memory.get().length).toBeLessThan(historyLenBefore);

    for (let turn = 1; turn <= 2; turn += 1) {
      ctx.mockNextResponse({ type: 'text', text: `after compaction ${turn}` });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: `continue ${turn}` }] });
      await ctx.untilTurnEnd();
    }

    const calls = ctx.llmCalls;
    expect(calls.length).toBeGreaterThan(callsBefore);
    const postCompaction = calls.slice(callsBefore);
    expect(postCompaction.length).toBeGreaterThanOrEqual(2);
    assertPrefixStable(postCompaction);
  });
});
