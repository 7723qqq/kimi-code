/**
 * Scenario: cache-miss micro compaction truncates old oversized tool results
 * in the outgoing request.
 *
 * Responsibilities: assert detection gating (cache-hit skip, flag off,
 * context usage ratio), cutoff lifecycle (apply / reset / undo clamp /
 * clear / compaction zeroing), truncation boundaries (minContentTokens,
 * toolCallId, non-tool messages), telemetry, and the llmRequester wiring that
 * truncates the projected request without mutating history. Run:
 * ../../node_modules/.bin/vitest run test/agent/microCompaction/microCompactionService.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { createHooks } from '#/hooks';
import { IFlagService } from '#/app/flag/flag';
import type { IEventBus} from '#/app/event/eventBus';
import { type DomainEvent } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { contextApplyCompaction, contextClear } from '#/agent/contextMemory/contextOps';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
} from '#/agent/loop/loop';
import type { Message } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import type { ModelCapability } from '#/kosong/contract/capability';
import {
  IAgentMicroCompactionService,
  type MicroCompactionConfig,
} from '#/agent/microCompaction/microCompaction';
import { AgentMicroCompactionService } from '#/agent/microCompaction/microCompactionService';
import {
  MicroCompactionModel,
  microCompactionApply,
} from '#/agent/microCompaction/microCompactionOps';
import { MICRO_COMPACTION_FLAG_ENV } from '#/agent/microCompaction/flag';
import { IWireService } from '#/wire/wire';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { recordingWireLog, registerTestAgentWire } from '../../wire/stubs';
import type { WireRecord } from '#/wire/record';
import { testAgent, type TestAgentContext } from '../../harness';

const MINUTE = 60 * 1000;
const DEFAULT_MARKER = '[Old tool result content cleared]';

const TEST_MODEL_CAPABILITIES: ModelCapability = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
};

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantMessage(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function toolMessage(text: string, toolCallId = 'call_1'): ContextMessage {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId };
}

function toolExchange(index: number, output: string): ContextMessage[] {
  const i = String(index);
  const toolCallId = `call_${i}`;
  return [
    userMessage(`lookup ${i}`),
    {
      role: 'assistant',
      content: [{ type: 'text', text: `calling Lookup ${i}` }],
      toolCalls: [
        { type: 'function', id: toolCallId, name: 'Lookup', arguments: `{"query":"item-${i}"}` },
      ],
    },
    toolMessage(output, toolCallId),
  ];
}

function textOf(message: Message | undefined): string {
  return (
    message?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('') ?? ''
  );
}

function hasMarker(messages: readonly Message[]): boolean {
  return messages.some((message) => textOf(message) === DEFAULT_MARKER);
}

function toolTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message));
}

type MicroHooks = ReturnType<typeof createMicroHooks>;

function createMicroHooks() {
  return createHooks<
    { onWillBeginStep: BeforeStepContext; onDidFinishStep: AfterStepContext },
    'onWillBeginStep' | 'onDidFinishStep'
  >(['onWillBeginStep', 'onDidFinishStep']);
}

interface UnitHarness {
  readonly svc: IAgentMicroCompactionService;
  readonly wire: IWireService;
  readonly records: WireRecord[];
  readonly telemetryRecords: TelemetryRecord[];
  readonly hooks: MicroHooks;
  readonly splice: (start: number, deleteCount: number) => void;
}

let flagEnabled = true;
let contextSize = 256_000;
let modelCapabilities: ModelCapability = TEST_MODEL_CAPABILITIES;
let history: ContextMessage[];

function createUnit(
  disposables: DisposableStore,
  config: Partial<MicroCompactionConfig> = {},
): UnitHarness {
  const ix = disposables.add(new TestInstantiationService());
  const records: WireRecord[] = [];
  const telemetryRecords: TelemetryRecord[] = [];
  const listeners = new Set<(event: DomainEvent) => void>();
  const eventBus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: ((typeOrHandler: unknown, handler?: unknown) => {
      if (typeof typeOrHandler === 'string') {
        const type = typeOrHandler;
        const onEvent = handler as (event: DomainEvent) => void;
        const wrapper = (event: DomainEvent): void => {
          if (event.type === type) onEvent(event as never);
        };
        listeners.add(wrapper);
        return toDisposable(() => listeners.delete(wrapper));
      }
      listeners.add(typeOrHandler as (event: DomainEvent) => void);
      return toDisposable(() =>
        listeners.delete(typeOrHandler as (event: DomainEvent) => void),
      );
    }) as IEventBus['subscribe'],
  };
  const hooks = createMicroHooks();

  ix.stub(IFlagService, { enabled: () => flagEnabled });
  ix.stub(IAgentContextMemoryService, { get: () => history });
  ix.stub(IAgentTokenCountingService, {
    get: () => ({ size: contextSize, measured: 0, estimated: 0 }),
  });
  ix.stub(IAgentProfileService, {
    data: () => ({
      modelAlias: 'test-model',
      modelCapabilities,
      thinkingLevel: 'off',
      systemPrompt: '',
    }),
  });
  ix.stub(IAgentLoopService, { hooks });
  ix.stub(ITelemetryService, recordingTelemetry(telemetryRecords));
  const wire = registerTestAgentWire(ix, 'wire/micro-compaction', {
    log: recordingWireLog(records),
    eventBus,
  });
  ix.set(IAgentMicroCompactionService, new SyncDescriptor(AgentMicroCompactionService));
  const svc = ix.get(IAgentMicroCompactionService);
  if (Object.keys(config).length > 0) {
    svc.setConfig(config);
  }
  return {
    svc,
    wire,
    records,
    telemetryRecords,
    hooks,
    splice: (start, deleteCount) =>
      eventBus.publish({ type: 'context.spliced', start, deleteCount, messages: [] }),
  };
}

async function finishStep(hooks: MicroHooks): Promise<void> {
  await hooks.onDidFinishStep.run({
    turnId: 1,
    step: 1,
    firstStepOfTurn: true,
    signal: new AbortController().signal,
    usage: emptyUsage(),
    finishReason: 'completed',
    stopTurn: false,
  });
}

describe('AgentMicroCompactionService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    flagEnabled = true;
    contextSize = 256_000;
    modelCapabilities = TEST_MODEL_CAPABILITIES;
    history = [];
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    disposables.dispose();
  });

  it('does nothing before the cache-miss threshold', async () => {
    const { svc, records, hooks } = createUnit(disposables, {
      keepRecentMessages: 4,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
    });
    history.push(...toolExchange(1, 'result one'), ...toolExchange(2, 'result two'));

    await finishStep(hooks);
    vi.setSystemTime(30 * MINUTE);

    svc.detect();
    expect(hasMarker(svc.compact(history))).toBe(false);
    expect(records.some((record) => record.type === 'micro_compaction.apply')).toBe(false);
  });

  it('truncates old tool results after a cache miss', async () => {
    const { svc, hooks } = createUnit(disposables, {
      keepRecentMessages: 4,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(
      ...toolExchange(1, 'old result one'),
      ...toolExchange(2, 'middle result two'),
      ...toolExchange(3, 'recent result three'),
    );

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    const messages = svc.compact(history);
    expect(messages).toHaveLength(9);
    expect(textOf(messages[2])).toBe(DEFAULT_MARKER);
    expect(textOf(messages[5])).toBe('middle result two');
    expect(textOf(messages[8])).toBe('recent result three');
    // History itself is untouched.
    expect(textOf(history[2])).toBe('old result one');
  });

  it('skips tool results below minContentTokens and truncates at the boundary', async () => {
    const { svc, hooks } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 100,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'ok'), ...toolExchange(2, 'x'.repeat(400)));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual(['ok', DEFAULT_MARKER]);
  });

  it('skips non-tool messages and tool-shaped messages without a toolCallId', async () => {
    const { svc, hooks } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(
      ...toolExchange(1, 'result one'),
      {
        role: 'tool',
        content: [{ type: 'text', text: 'orphan tool-like output' }],
        toolCalls: [],
      },
    );

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual([DEFAULT_MARKER, 'orphan tool-like output']);
  });

  it('does not apply when context usage is below minContextUsageRatio', async () => {
    const { svc, hooks, records } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0.9,
    });
    contextSize = 1_000;
    history.push(...toolExchange(1, 'result one'));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    expect(hasMarker(svc.compact(history))).toBe(false);
    expect(records.some((record) => record.type === 'micro_compaction.apply')).toBe(false);
  });

  it('applies when the context window is unknown', async () => {
    const { svc, hooks } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
    });
    modelCapabilities = { ...TEST_MODEL_CAPABILITIES, max_context_tokens: 0 };
    contextSize = 1_000;
    history.push(...toolExchange(1, 'result one'));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual([DEFAULT_MARKER]);
  });

  it('keeps the cutoff while the cache is warm and advances it on the next miss', async () => {
    const { svc, hooks } = createUnit(disposables, {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'result one'), ...toolExchange(2, 'result two'));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);
    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual([DEFAULT_MARKER, 'result two']);

    history.push(...toolExchange(3, 'result three'));
    await finishStep(hooks);
    vi.setSystemTime(63 * MINUTE);
    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);

    vi.setSystemTime(123 * MINUTE);
    svc.detect();
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);
  });

  it('resets the cutoff to zero and only ever shrinks it', () => {
    const { svc, wire } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(
      ...toolExchange(1, 'result one'),
      ...toolExchange(2, 'result two'),
      ...toolExchange(3, 'result three'),
    );

    wire.dispatch(microCompactionApply({ cutoff: 7 }));
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    svc.reset();
    expect(hasMarker(svc.compact(history))).toBe(false);

    wire.dispatch(microCompactionApply({ cutoff: 7 }));
    svc.reset(5);
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);
    // reset only ever shrinks the cutoff.
    svc.reset(8);
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);
  });

  it('clamps the cutoff via context.spliced undo events', () => {
    const { svc, wire, splice } = createUnit(disposables, {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(
      ...toolExchange(1, 'result one'),
      ...toolExchange(2, 'result two'),
      ...toolExchange(3, 'result three'),
    );
    wire.dispatch(microCompactionApply({ cutoff: 7 }));
    expect(toolTexts(svc.compact(history))).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    // Undo splice: cutoff clamps down to the surviving history length.
    splice(3, 6);
    expect(toolTexts(svc.compact(history))).toEqual([DEFAULT_MARKER, 'result two', 'result three']);

    // A later splice at a higher index cannot raise the cutoff again.
    splice(5, 1);
    expect(toolTexts(svc.compact(history))).toEqual([DEFAULT_MARKER, 'result two', 'result three']);
  });

  it('zeroes the cutoff on context clear and compaction via wire cross-reducers', () => {
    const { svc, wire } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'result one'));

    wire.dispatch(microCompactionApply({ cutoff: 5 }));
    expect(wire.getModel(MicroCompactionModel).cutoff).toBe(5);

    wire.dispatch(contextClear({}));
    expect(wire.getModel(MicroCompactionModel).cutoff).toBe(0);

    wire.dispatch(microCompactionApply({ cutoff: 5 }));
    wire.dispatch(contextApplyCompaction({ summary: 'Summary.', compactedCount: 1 }));
    expect(wire.getModel(MicroCompactionModel).cutoff).toBe(0);
  });

  it('tracks telemetry when a cache miss advances the cutoff', async () => {
    const { svc, hooks, telemetryRecords } = createUnit(disposables, {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(
      ...toolExchange(1, 'result one '.repeat(20)),
      ...toolExchange(2, 'result two '.repeat(20)),
      ...toolExchange(3, 'result three'),
    );

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    const events = telemetryRecords.filter(
      (record) => record.event === 'micro_compaction_finished',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({
      keep_recent_messages: 2,
      min_content_tokens: 1,
      cache_missed_threshold_ms: 60 * MINUTE,
      truncated_marker: DEFAULT_MARKER,
      min_context_usage_ratio: 0,
      previous_cutoff: 0,
      cutoff: 7,
      message_count: 9,
      cache_age_ms: 61 * MINUTE,
      truncated_tool_result_count: 2,
      thinking_effort: 'off',
    });
    const props = events[0]!.properties ?? {};
    const before = props['truncated_tool_result_tokens_before'] as number;
    const after = props['truncated_tool_result_tokens_after'] as number;
    expect(before).toBeGreaterThan(after);
    expect(props['tokens_before'] as number).toBeGreaterThan(props['tokens_after'] as number);
  });

  it('does not emit telemetry again when the cutoff does not advance', async () => {
    const { svc, hooks, telemetryRecords } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'result one'));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);
    svc.detect();
    vi.setSystemTime(62 * MINUTE);
    svc.detect();

    expect(
      telemetryRecords.filter((record) => record.event === 'micro_compaction_finished'),
    ).toHaveLength(1);
  });

  it('leaves messages unchanged when the flag is disabled', async () => {
    flagEnabled = false;
    const { svc, hooks, records } = createUnit(disposables, {
      keepRecentMessages: 0,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'result one'));

    await finishStep(hooks);
    vi.setSystemTime(61 * MINUTE);

    svc.detect();
    expect(svc.compact(history)).toBe(history);
    expect(toolTexts(svc.compact(history))).toEqual(['result one']);
    expect(records.some((record) => record.type === 'micro_compaction.apply')).toBe(false);
  });

  it('persists the cutoff as a wire record', () => {
    const { svc, wire, records } = createUnit(disposables, {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
    history.push(...toolExchange(1, 'result one'), ...toolExchange(2, 'result two'));

    wire.dispatch(microCompactionApply({ cutoff: 7 }));
    const record = records.findLast(
      (candidate) => candidate.type === 'micro_compaction.apply',
    );
    expect(record?.['cutoff']).toBe(7);
  });
});

describe('MicroCompaction (integration)', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '1');
    vi.useFakeTimers();
    vi.setSystemTime(0);
    ctx = testAgent();
    ctx.get(IAgentMicroCompactionService).setConfig({
      keepRecentMessages: 4,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('sends truncated old tool results to the next model request without mutating history', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'warm' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'warm up' }] });
    await ctx.untilTurnEnd();

    const memory = ctx.get(IAgentContextMemoryService);
    memory.append(
      ...toolExchange(1, 'old result one'),
      ...toolExchange(2, 'middle result two'),
      ...toolExchange(3, 'recent result three'),
    );

    vi.setSystemTime(61 * MINUTE);
    ctx.mockNextResponse({ type: 'text', text: 'done after micro compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    const call = ctx.llmCalls.at(-1);
    expect(textOf(call?.history[4])).toBe(DEFAULT_MARKER);
    expect(textOf(call?.history[7])).toBe(DEFAULT_MARKER);
    expect(textOf(call?.history[10])).toBe('recent result three');

    expect(textOf(memory.get()[4])).toBe('old result one');
    expect(textOf(memory.get()[7])).toBe('middle result two');
    expect(textOf(memory.get()[10])).toBe('recent result three');
  });

  it('clamps the cutoff when undo shortens the context', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'warm' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'warm up' }] });
    await ctx.untilTurnEnd();

    const memory = ctx.get(IAgentContextMemoryService);
    memory.append(
      ...toolExchange(1, 'result one'),
      ...toolExchange(2, 'result two'),
      ...toolExchange(3, 'result three'),
    );

    vi.setSystemTime(61 * MINUTE);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    const wire = ctx.get(IWireService);
    const cutoffAfterDetect = wire.getModel(MicroCompactionModel).cutoff;
    expect(cutoffAfterDetect).toBeGreaterThan(0);

    memory.undo(2);
    const newLength = memory.get().length;
    expect(wire.getModel(MicroCompactionModel).cutoff).toBe(
      Math.min(cutoffAfterDetect, newLength),
    );
  });
});
