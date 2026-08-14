/**
 * Trajectory pure-logic tests: ledger filtering, layout folding,
 * timeline projection, and virtual-row windowing. Ported from
 * deepseek-harness ui-trajectory semantics (MIT).
 * Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/trajectory.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  LEDGER_MAX_FRAMES,
  createEventLedger,
  feedLedger,
  type LedgerFrame,
} from '../src/lib/trajectory/ledger';
import { deriveTrajectoryLayout } from '../src/lib/trajectory/records';
import {
  deriveTrajectoryTimeline,
  trajectoryTimelineFocusIndexes,
} from '../src/lib/trajectory/timeline';
import {
  groupTrajectoryVirtualRows,
  trajectoryVirtualWindow,
} from '../src/lib/trajectory/virtualRows';

function frame(
  type: string,
  payload: Record<string, unknown> | null = {},
  timestamp = '2026-08-15T00:00:00.000Z',
  seq = 1,
): LedgerFrame {
  return { type, seq, timestamp, payload };
}

describe('event ledger', () => {
  it('keeps only trajectory-relevant frames', () => {
    let s = createEventLedger();
    s = feedLedger(s, frame('turn.started'));
    s = feedLedger(s, frame('assistant.delta', { text: 'x' }));
    s = feedLedger(s, frame('agent.status.updated', { model: 'kimi' }));
    s = feedLedger(s, frame('some.noise', { value: 1 }));
    expect(s.frames.map((f) => f.type)).toEqual([
      'turn.started',
      'assistant.delta',
      'agent.status.updated',
    ]);
  });

  it('ignores subagent frames', () => {
    let s = createEventLedger();
    s = feedLedger(s, frame('turn.started', { agentId: 'sub-1' }));
    expect(s.frames).toHaveLength(0);
  });

  it('caps retained frames at LEDGER_MAX_FRAMES', () => {
    let s = createEventLedger();
    for (let i = 0; i < LEDGER_MAX_FRAMES + 10; i += 1) {
      s = feedLedger(s, frame('turn.started', {}, '2026-08-15T00:00:00.000Z', i));
    }
    expect(s.frames).toHaveLength(LEDGER_MAX_FRAMES);
    expect(s.frames[0]?.seq).toBe(10);
  });
});

describe('trajectory layout', () => {
  it('folds a full turn: user, step groups, assistant, tool call', () => {
    const turns = deriveTrajectoryLayout([
      frame('prompt.submitted', { content: [{ type: 'text', text: 'hi' }] }, '2026-08-15T00:00:00.000Z', 1),
      frame('turn.started', { turnId: 1 }, '2026-08-15T00:00:00.100Z', 2),
      frame('turn.step.started', { step: 1 }, '2026-08-15T00:00:00.200Z', 3),
      frame('assistant.delta', { text: 'let me check' }, '2026-08-15T00:00:00.300Z', 4),
      frame('tool.call.started', { toolCallId: 'c1', toolName: 'Bash' }, '2026-08-15T00:00:00.400Z', 5),
      frame('tool.result', { toolCallId: 'c1', output: 'ok' }, '2026-08-15T00:01:00.400Z', 6),
      frame(
        'turn.step.completed',
        {
          usage: { inputOther: 10, inputCacheRead: 5, output: 3 },
          llmFirstTokenLatencyMs: 80,
          llmStreamDurationMs: 900,
        },
        '2026-08-15T00:01:00.500Z',
        7,
      ),
      frame('turn.ended', { turnId: 1 }, '2026-08-15T00:01:00.600Z', 8),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.turn).toBe(1);
    const groups = turns[0]!.groups;
    expect(groups.map((g) => g.title)).toEqual(['Message', 'Step 1']);
    const user = groups[0]!.records[0]!;
    expect(user).toMatchObject({ kind: 'user', text: 'hi', opensTurn: true });
    const step = groups[1]!.records;
    expect(step).toHaveLength(2);
    expect(step[0]).toMatchObject({
      kind: 'assistant',
      outputDetail: 'let me check',
      input: 15,
      cacheRead: 5,
      output: 3,
      ttftMs: 80,
      streamMs: 900,
    });
    expect(step[1]).toMatchObject({
      kind: 'tool',
      toolName: 'Bash',
      callId: 'c1',
      result: 'ok',
    });
    // Tool wall time: 60.0s (result 00:01:00.400 - started 00:00:00.400).
    expect(step[1]!.timeSeconds).toBeCloseTo(60.0, 6);
  });

  it('merges streaming deltas and marks interrupted steps', () => {
    const turns = deriveTrajectoryLayout([
      frame('turn.started', { turnId: 2 }, '2026-08-15T00:00:00.000Z', 1),
      frame('turn.step.started', { step: 1 }, '2026-08-15T00:00:00.100Z', 2),
      frame('assistant.delta', { text: 'a' }, '2026-08-15T00:00:00.200Z', 3),
      frame('assistant.delta', { text: 'b' }, '2026-08-15T00:00:00.300Z', 4),
      frame('thinking.delta', { thinking: 'hmm' }, '2026-08-15T00:00:00.400Z', 5),
      frame('turn.step.interrupted', { step: 1 }, '2026-08-15T00:00:00.500Z', 6),
    ]);
    const rec = turns[0]!.groups[0]!.records[0]!;
    expect(rec).toMatchObject({
      kind: 'assistant',
      outputDetail: 'ab',
      thinkingDetail: 'hmm',
      isError: true,
    });
  });

  it('places compaction between turns when no turn is open', () => {
    const turns = deriveTrajectoryLayout([
      frame('session.history_compacted', { reason: 'auto_compact' }, '2026-08-15T00:00:00.000Z', 1),
    ]);
    expect(turns[0]!.turn).toBeNull();
    expect(turns[0]!.groups[0]!.records[0]).toMatchObject({
      kind: 'compacted',
      text: expect.stringContaining('auto_compact'),
    });
  });
});

describe('timeline projection', () => {
  it('projects sequence spans with lanes and turn boundaries', () => {
    const turns = deriveTrajectoryLayout([
      frame('prompt.submitted', { content: [{ type: 'text', text: 'q' }] }, '2026-08-15T00:00:00.000Z', 1),
      frame('turn.started', { turnId: 1 }, '2026-08-15T00:00:00.100Z', 2),
      frame('turn.step.started', { step: 1 }, '2026-08-15T00:00:00.200Z', 3),
      frame('assistant.delta', { text: 'x' }, '2026-08-15T00:00:00.300Z', 4),
      frame('turn.step.completed', { usage: { output: 1 } }, '2026-08-15T00:00:01.000Z', 5),
    ]);
    const model = deriveTrajectoryTimeline(turns, 'sequence');
    expect(model).not.toBeNull();
    expect(model!.spans.map((s) => s.kind)).toEqual(['user', 'assistant']);
    expect(model!.spans[0]!.lane).toBe(0);
    expect(model!.spans[1]!.lane).toBe(1);
    // The boundary marks the turn's start in span units (0 = before its first
    // span), mirroring deepseek-harness's timeline projection.
    expect(model!.turnBoundaries).toEqual([{ turn: 1, time: 0 }]);
  });

  it('focuses the records active inside a selected interval', () => {
    const turns = deriveTrajectoryLayout([
      frame('turn.started', { turnId: 1 }, '2026-08-15T00:00:00.000Z', 1),
      frame('turn.step.started', { step: 1 }, '2026-08-15T00:00:00.100Z', 2),
      frame('assistant.delta', { text: 'a' }, '2026-08-15T00:00:00.200Z', 3),
      frame('turn.step.completed', { usage: { output: 1 } }, '2026-08-15T00:00:00.900Z', 4),
      frame('turn.step.started', { step: 2 }, '2026-08-15T00:01:00.000Z', 5),
      frame('turn.step.completed', { usage: { output: 1 } }, '2026-08-15T00:01:01.000Z', 6),
    ]);
    const focused = trajectoryTimelineFocusIndexes(
      turns,
      { start: 0.5, end: 1.5 },
      'sequence',
    );
    // Sequence domain: step 1 at [0,1), step 2 at [1,2). The inclusive
    // interval [0.5,1.5] touches both steps.
    expect(focused).toEqual(
      new Set([turns[0]!.groups[0]!.records[0]!.index, turns[0]!.groups[1]!.records[0]!.index]),
    );
  });
});

describe('virtual rows', () => {
  it('projects a content row and computes the visible window', () => {
    const turns = deriveTrajectoryLayout([
      frame('turn.started', { turnId: 1 }, '2026-08-15T00:00:00.000Z', 1),
      frame('turn.step.started', { step: 1 }, '2026-08-15T00:00:00.100Z', 2),
      frame('turn.step.completed', { usage: { output: 1 } }, '2026-08-15T00:00:00.500Z', 3),
    ]);
    const records = turns[0]!.groups.flatMap((g) => g.records);
    const rows = groupTrajectoryVirtualRows(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.height).toBe(30);
    const windowModel = trajectoryVirtualWindow(rows, 0, 400);
    expect(windowModel.totalHeight).toBe(30);
    expect(windowModel.start).toBe(0);
    expect(windowModel.end).toBe(1);
  });
});
