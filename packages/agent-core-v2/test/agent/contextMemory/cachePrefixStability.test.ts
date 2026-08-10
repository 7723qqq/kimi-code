/**
 * Cache-prefix stability contract.
 *
 * Ported from Reasonix's `TestCacheHitPrefixStable` / `tool-loop` guard:
 * the provider-side prompt cache only hits when every request re-sends the
 * full prior history **unchanged** — append-only growth, never a rewrite of
 * already-sent messages. This test asserts that invariant structurally at the
 * generate() boundary (the same messages a provider would serialize), so any
 * future change that mutates history between steps (e.g. injecting a system
 * message mid-tool-loop, re-ordering messages, rewriting tool results) fails
 * here before it can crater a real provider's cache hit rate.
 *
 * The three scenarios mirror the kinds of sessions that must stay stable:
 *  1. plain multi-turn dialogue
 *  2. tool loops (assistant(tool_call) + tool(result) pairs appended per step)
 *  3. post-compaction (summary + kept tail become the new stable prefix)
 */

import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ExecutableTool } from '#/agent/toolExecutor/toolExecutor';
import type { Message, ToolCall } from '#/kosong/contract/message';
import { permissionModeServices, createTestAgent } from '../../harness/agent';
import type { GenerateCall } from '../../harness/snapshots';

function assertPrefixStable(calls: readonly GenerateCall[]): void {
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < calls.length; i += 1) {
    const prev = calls[i - 1]!.history;
    const curr = calls[i]!.history;
    // Append-only: the new request must contain the previous request's entire
    // history as its prefix, message-for-message.
    expect(curr.length, `request ${i} must not shrink history`).toBeGreaterThanOrEqual(prev.length);
    expect(
      curr.slice(0, prev.length),
      `request ${i} must re-send the previous request's history unchanged`,
    ).toEqual(prev);
  }
  // The cacheable head (system prompt + tools) must never change mid-session.
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

    // One user turn, three LLM steps: tool call -> tool call -> final answer.
    ctx.mockNextResponse({ type: 'text', text: 'checking' }, lookupCall(1));
    ctx.mockNextResponse({ type: 'text', text: 'checking again' }, lookupCall(2));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'look up moon' }] });
    await ctx.untilTurnEnd();

    assertPrefixStable(ctx.llmCalls);
    // The tool loop must never inject non-user/assistant/tool messages (a
    // mid-history system message breaks provider caches — see the DeepSeek
    // cache incident that this contract guards against).
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

    // Force a compaction through the same op the full-compaction service uses.
    const historyLenBefore = memory.get().length;
    memory.applyCompaction({
      summary: 'summary of earlier turns',
      compactedCount: memory.get().length,
      tokensBefore: 10_000,
      summaryOutputTokens: 20,
    });
    // The compaction must have actually shrunk the context (old messages
    // replaced by the summary) — otherwise nothing was compacted.
    expect(memory.get().length).toBeLessThan(historyLenBefore);

    // Post-compaction requests must re-send the summary + kept tail unchanged.
    for (let turn = 1; turn <= 2; turn += 1) {
      ctx.mockNextResponse({ type: 'text', text: `after compaction ${turn}` });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: `continue ${turn}` }] });
      await ctx.untilTurnEnd();
    }

    const calls = ctx.llmCalls;
    expect(calls.length).toBeGreaterThan(callsBefore);
    // Compaction legitimately rewrites the prefix (summary replaces old
    // messages) — that first post-compaction request misses the cache and
    // rebuilds it. What must hold is that *subsequent* requests keep the new
    // prefix (summary + kept tail) byte-stable.
    const postCompaction = calls.slice(callsBefore);
    expect(postCompaction.length).toBeGreaterThanOrEqual(2);
    assertPrefixStable(postCompaction);
  });
});
