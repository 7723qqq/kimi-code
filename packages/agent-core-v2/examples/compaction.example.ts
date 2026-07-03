/**
 * Scenario: the **compaction** slice — the context-size signal that chooses
 * between micro and full compaction.
 *
 * Concept taught: context management is driven by a single *reading* — the
 * Agent-scope `IAgentContextSizeService` reports how large the conversation has
 * grown (`getStatus().contextTokensWithPending`). Two distinct Agent-scope
 * strategies consume that same reading and fire at different thresholds:
 *
 *   - **micro compaction** (`IAgentMicroCompactionService`) — cheap; clears the
 *     bodies of old tool results. It triggers when the reading reaches
 *     `minContextUsageRatio` (0.5) of the model window.
 *   - **full compaction** (`IAgentFullCompactionService`) — expensive; asks the
 *     LLM to summarize the prefix. It triggers when the reading reaches the
 *     model window's `triggerRatio` (0.85), via
 *     `DefaultCompactionStrategy.shouldCompact`.
 *
 * We deliberately do NOT wire the two compaction services end-to-end here:
 * each injects roughly 8–11 heavy collaborators (context memory, wire record,
 * profile, loop, turn, LLM requester, …). Instead we demonstrate the smallest
 * true thing: the real `AgentContextSizeService` is resolved through the scope
 * tree with only its two genuine collaborators stubbed. We assert its real
 * behavior — a measurement updates the reading, splicing messages into context
 * memory raises the pending estimate through the real `onSpliced` hook, and a
 * change emits the live `agent.status.updated` signal — and then show that
 * this real reading flips a faithful micro/full decision as it crosses the
 * 0.5 and 0.85 thresholds.
 *
 * Real: `AgentContextSizeService`. Stubbed: `IAgentContextMemoryService`
 * (in-memory fake carrying a real `onSpliced` hook) and `IAgentRecordService`
 * (append / signal / define doubles). No App- or Session-scope seeds are
 * required, because the size service injects only those two Agent-scope peers.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/compaction.example.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { estimateTokensForMessages } from '#/_base/utils/tokens';

import {
  AgentContextSizeService,
  type ContextSizeStatus,
  IAgentContextSizeService,
} from '#/agent/contextSize';
import {
  type ContextMessage,
  IAgentContextMemoryService,
} from '#/agent/contextMemory';
import { IAgentRecordService } from '#/agent/record';
import { createHooks } from '#/hooks';

/**
 * In-memory `IAgentContextMemoryService` with a real `onSpliced` hook. The real
 * `AgentContextSizeService` registers a handler on this hook in its
 * constructor, so splicing here drives the size service exactly as the real
 * context memory would.
 */
function fakeContextMemory(): IAgentContextMemoryService {
  const messages: ContextMessage[] = [];
  const hooks = createHooks<{
    onSpliced: {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    };
  }>(['onSpliced']);
  return {
    _serviceBrand: undefined,
    hooks,
    get: () => [...messages],
    splice: (start, deleteCount, inserted, tokens) => {
      const added = [...inserted];
      messages.splice(start, deleteCount, ...added);
      void hooks.onSpliced.run({
        start,
        deleteCount,
        messages: added,
        tokens,
      });
    },
  };
}

/** `IAgentRecordService` double — exposes the `signal` spy so tests can assert the live size signal. */
function fakeRecordService() {
  const signal = vi.fn();
  const service = {
    _serviceBrand: undefined,
    append: vi.fn(),
    signal,
    define: () => ({ dispose: () => {} }),
    restoring: null,
  } as unknown as IAgentRecordService;
  return { service, signal };
}

type CompactionDecision = 'none' | 'micro' | 'full';

/**
 * Faithful mirror of the two real thresholds, both consuming the same real
 * reading (`status.contextTokensWithPending`):
 *   - micro compaction fires at `minContextUsageRatio` (0.5) of the window
 *     (see `AgentMicroCompactionService.contextSizeRatio` / `detect`);
 *   - full compaction fires at the model window `triggerRatio` (0.85)
 *     (see `DefaultCompactionStrategy.shouldCompact`).
 */
function decideCompaction(
  status: ContextSizeStatus,
  maxContextTokens: number,
): CompactionDecision {
  if (maxContextTokens <= 0) return 'none';
  const ratio = status.contextTokensWithPending / maxContextTokens;
  if (ratio >= 0.85) return 'full';
  if (ratio >= 0.5) return 'micro';
  return 'none';
}

describe('compaction slice (context-size signal → micro vs full decision)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    // Register the one real Agent-scope service of the slice. Its two
    // collaborators are supplied as stubPair seeds on the Agent scope below.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentContextSizeService,
      AgentContextSizeService,
    );
  });

  it('reports a zero reading, then reflects a real measurement', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IAgentContextMemoryService, fakeContextMemory()),
      stubPair(IAgentRecordService, fakeRecordService().service),
    ]);

    const size = agent.accessor.get(IAgentContextSizeService);
    expect(size.getStatus()).toEqual({
      contextTokens: 0,
      contextTokensWithPending: 0,
    });

    size.measured(0, 42_000);
    expect(size.getStatus()).toEqual({
      contextTokens: 42_000,
      contextTokensWithPending: 42_000,
    });

    host.dispose();
  });

  it('emits agent.status.updated when the measured size changes', () => {
    const record = fakeRecordService();
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IAgentContextMemoryService, fakeContextMemory()),
      stubPair(IAgentRecordService, record.service),
    ]);

    const size = agent.accessor.get(IAgentContextSizeService);
    size.measured(0, 80_000);

    // The live "context-size signal" the rest of the agent reacts to.
    expect(record.signal).toHaveBeenCalledWith({
      type: 'agent.status.updated',
      contextTokens: 80_000,
    });

    host.dispose();
  });

  it('tracks pending tokens as messages are spliced into context memory', () => {
    const context = fakeContextMemory();
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IAgentContextMemoryService, context),
      stubPair(IAgentRecordService, fakeRecordService().service),
    ]);

    const size = agent.accessor.get(IAgentContextSizeService);
    // Wake the delayed proxy so its constructor runs and registers the
    // `onSpliced` handler before we splice.
    size.getStatus();

    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there, how can I help?' }],
        toolCalls: [],
      },
    ];
    context.splice(0, 0, messages);

    // No measurement yet, so the whole estimate is "pending".
    expect(size.getStatus().contextTokens).toBe(0);
    expect(size.getStatus().contextTokensWithPending).toBe(
      estimateTokensForMessages(messages),
    );

    host.dispose();
  });

  it('drives a micro vs full compaction decision from the size reading', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IAgentContextMemoryService, fakeContextMemory()),
      stubPair(IAgentRecordService, fakeRecordService().service),
    ]);

    const size = agent.accessor.get(IAgentContextSizeService);
    const window = 200_000; // model max_context_tokens

    size.measured(0, 40_000); // 0.20 of the window
    expect(decideCompaction(size.getStatus(), window)).toBe('none');

    size.measured(0, 120_000); // 0.60 of the window → micro (>= 0.5)
    expect(decideCompaction(size.getStatus(), window)).toBe('micro');

    size.measured(0, 180_000); // 0.90 of the window → full (>= 0.85)
    expect(decideCompaction(size.getStatus(), window)).toBe('full');

    host.dispose();
  });
});
