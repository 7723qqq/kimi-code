/**
 * Scenario: the **usage-replay** slice — usage metering backed by the record
 * log, and rebuilding state by replaying records.
 *
 * Concept taught: `IAgentUsageService` records token usage per model and per
 * turn. Every `record(model, usage, context)` appends a `usage.record` to the
 * append-log *and* applies it to the in-memory aggregate; on resume, the
 * `usage.record` `resume` facet replays each stored record to rebuild the same
 * aggregate without re-appending or re-signaling. The `context.type === 'turn'`
 * form additionally tracks a per-`turnId` window that resets when the turn
 * changes.
 *
 * `IAgentRecordService` (which owns the replay read model),
 * `IAgentSystemReminderService`, and `IAgentExternalHooksService` are siblings
 * in this cross-cutting layer; the composition root wires them for real, but
 * this slice focuses on usage because it is the smallest and self-contained.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator;
 * we spy on the real `IAgentRecordService` to observe the appended records and
 * capture the `resume` facet.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/usage-replay.example.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentRecordService } from '#/agent/record';
import { IAgentUsageService } from '#/agent/usage';
import type { TokenUsage } from '#/app/llmProtocol';

import { createSliceHost, type SliceHost } from './_harness';

const u = (inputOther: number, output: number): TokenUsage => ({
  inputOther,
  output,
  inputCacheRead: 0,
  inputCacheCreation: 0,
});

describe('usage-replay slice (IAgentUsageService + record fan-out)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    const records = host.agent.accessor.get(IAgentRecordService);
    const appended: Array<{ type: string; model?: string }> = [];
    const signals: Array<{ type: string }> = [];
    const facets = new Map<string, { resume?: (r: { type: string }) => unknown }>();
    vi.spyOn(records, 'append').mockImplementation((r) => {
      appended.push(r as { type: string; model?: string });
    });
    vi.spyOn(records, 'signal').mockImplementation((s) => {
      signals.push(s as { type: string });
    });
    vi.spyOn(records, 'define').mockImplementation((type, facet) => {
      facets.set(type as string, facet as { resume?: (r: { type: string }) => unknown });
      return { dispose: () => facets.delete(type as string) };
    });
    const usage = host.agent.accessor.get(IAgentUsageService);
    return { usage, appended, signals, facets };
  }

  it('aggregates recorded usage per model and exposes a running total', () => {
    const { usage } = setUp();

    usage.record('gpt-a', u(10, 5));
    usage.record('gpt-a', u(3, 2));
    usage.record('gpt-b', u(100, 50));

    const status = usage.status();
    expect(status?.byModel?.['gpt-a']).toEqual(u(13, 7));
    expect(status?.byModel?.['gpt-b']).toEqual(u(100, 50));
  });

  it('tracks the current turn and resets the window when the turnId changes', () => {
    const { usage } = setUp();

    usage.record('m', u(1, 1), { type: 'turn', turnId: 1 });
    usage.record('m', u(2, 2), { type: 'turn', turnId: 1 });
    expect(usage.status()?.currentTurn).toEqual(u(3, 3));

    usage.record('m', u(9, 9), { type: 'turn', turnId: 2 });
    expect(usage.status()?.currentTurn).toEqual(u(9, 9));
  });

  it('record() fans out to one append plus an agent.status.updated signal', () => {
    const { usage, appended, signals } = setUp();

    usage.record('m', u(1, 1));

    expect(appended).toEqual([
      { type: 'usage.record', model: 'm', usage: u(1, 1), context: undefined },
    ]);
    expect(signals.map((s) => s.type)).toContain('agent.status.updated');
  });

  it('rebuilds usage from restored records through the usage.record resume facet', () => {
    const { usage, facets, appended } = setUp();

    // Wake the lazy service so its constructor registers the resume facet.
    usage.status();
    const resume = facets.get('usage.record')?.resume;
    expect(resume).toBeTypeOf('function');

    resume!({ type: 'usage.record', model: 'restored', usage: u(7, 3) });

    expect(usage.status()?.byModel?.['restored']).toEqual(u(7, 3));
    // Replay must not re-append or re-signal.
    expect(appended).toEqual([]);
  });
});
