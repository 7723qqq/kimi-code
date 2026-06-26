import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ITelemetryService, type TelemetryProperties } from '#/telemetry/telemetry';
import { IToolDedupe, type ToolDedupResult } from '#/toolDedup/toolDedupe';
import { ToolDedupeService, __testing } from '#/toolDedup/toolDedupeService';
import { ITurnService } from '#/turn';
import { stubTurnWithHooks } from '../turn/stubs';

interface RecordedTelemetryEvent {
  readonly event: string;
  readonly properties: TelemetryProperties | undefined;
}

const { REMINDER_TEXT_1 } = __testing;

function okResult(text: string): ToolDedupResult {
  return { output: text };
}

function errResult(text: string): ToolDedupResult {
  return { output: text, isError: true };
}

async function runOriginal(
  deduper: IToolDedupe,
  callId: string,
  tool: string,
  args: unknown,
  result: ToolDedupResult,
): Promise<ToolDedupResult> {
  const cached = deduper.checkSameStep(callId, tool, args);
  expect(cached).toBeNull();
  return deduper.finalizeResult(callId, tool, args, result);
}

describe('ToolDedupeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: RecordedTelemetryEvent[];

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    events = [];
    ix.stub(ITelemetryService, {
      track(event: string, properties?: TelemetryProperties) {
        events.push({ event, properties });
      },
    });
    ix.stub(ITurnService, stubTurnWithHooks());
    ix.set(IToolDedupe, new SyncDescriptor(ToolDedupeService));
  });

  afterEach(() => disposables.dispose());

  it('resolves same-step duplicate calls to the original result', async () => {
    const deduper = ix.get(IToolDedupe);
    deduper.beginStep();
    const originalCached = deduper.checkSameStep('c1', 'Read', { path: '/a' });
    const duplicateCached = deduper.checkSameStep('c2', 'Read', { path: '/a' });
    expect(originalCached).toBeNull();
    expect(duplicateCached).toEqual({ output: '' });

    const original = await deduper.finalizeResult('c1', 'Read', { path: '/a' }, okResult('A'));
    const duplicate = await deduper.finalizeResult('c2', 'Read', { path: '/a' }, duplicateCached!);
    expect(original).toEqual(okResult('A'));
    expect(duplicate).toEqual(okResult('A'));
  });

  it('uses canonical argument keys for same-step dedupe', async () => {
    const deduper = ix.get(IToolDedupe);
    deduper.beginStep();
    await runOriginal(deduper, 'c1', 'Read', { a: 1, b: 2 }, okResult('SAME'));
    const cached = deduper.checkSameStep('c2', 'Read', { b: 2, a: 1 });
    expect(cached).not.toBeNull();
    const duplicate = await deduper.finalizeResult('c2', 'Read', { b: 2, a: 1 }, cached!);
    expect(duplicate).toEqual(okResult('SAME'));
  });

  it('injects a reminder at the third consecutive cross-step repeat', async () => {
    const deduper = ix.get(IToolDedupe);
    let last: ToolDedupResult | undefined;
    for (let i = 0; i < 3; i += 1) {
      deduper.beginStep();
      last = await runOriginal(deduper, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
      deduper.endStep();
    }
    expect(last!.output as string).toContain('repeating the exact same tool call');
    expect(last!.output as string).not.toContain('repeated_times');
    expect(deduper.currentStreak).toBe(3);
  });

  it('does not treat same-step spam alone as cross-step repetition', async () => {
    const deduper = ix.get(IToolDedupe);
    deduper.beginStep();
    expect(deduper.checkSameStep('orig', 'Read', { p: 1 })).toBeNull();
    for (let i = 0; i < 7; i += 1) {
      expect(deduper.checkSameStep(`dup${String(i)}`, 'Read', { p: 1 })).not.toBeNull();
    }
    const final = await deduper.finalizeResult('orig', 'Read', { p: 1 }, okResult('R'));
    expect(final.output as string).not.toContain('<system-reminder>');
  });

  it('force-stops at the twelfth consecutive repeat without changing error state', async () => {
    const deduper = ix.get(IToolDedupe);
    let success: ToolDedupResult | undefined;
    for (let i = 0; i < 12; i += 1) {
      deduper.beginStep();
      success = await runOriginal(deduper, `s${String(i)}`, 'Read', { p: 1 }, okResult('R'));
      deduper.endStep();
    }
    expect(success!.stopTurn).toBe(true);
    expect(success!.isError).toBeUndefined();

    deduper.beginStep();
    const error = await runOriginal(deduper, 'error', 'Read', { p: 1 }, errResult('boom'));
    deduper.endStep();
    expect(error.stopTurn).toBe(true);
    expect(error.isError).toBe(true);
  });

  it('appends reminders to trailing text content parts', async () => {
    const deduper = ix.get(IToolDedupe);
    for (let i = 0; i < 2; i += 1) {
      deduper.beginStep();
      await runOriginal(deduper, `p${String(i)}`, 'Tool', {}, okResult('R'));
      deduper.endStep();
    }
    deduper.beginStep();
    const final = await runOriginal(
      deduper,
      'final',
      'Tool',
      {},
      { output: [{ type: 'text', text: 'hello' }] },
    );
    deduper.endStep();
    expect(final.output).toEqual([{ type: 'text', text: `hello${REMINDER_TEXT_1}` }]);
  });

  it('emits repeat telemetry with tiered actions', async () => {
    const deduper = ix.get(IToolDedupe);
    for (let i = 0; i < 5; i += 1) {
      deduper.beginStep();
      await runOriginal(deduper, `c${String(i)}`, 'Read', { p: 1 }, okResult('R'));
      deduper.endStep();
    }
    const repeats = events.filter((event) => event.event === 'tool_call_repeat');
    expect(repeats.map((event) => event.properties?.['repeat_count'])).toEqual([2, 3, 4, 5]);
    expect(repeats.map((event) => event.properties?.['action'])).toEqual(['none', 'r1', 'r1', 'r2']);
    expect(repeats.every((event) => event.properties?.['tool_name'] === 'Read')).toBe(true);
  });
});
