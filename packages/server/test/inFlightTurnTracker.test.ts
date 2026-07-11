/**
 * `InFlightTurnTracker` — the snapshot `in_flight_turn` must describe only the
 * CURRENTLY streaming step. The snapshot transcript already carries every
 * completed step's text/thinking; if the tracker kept accumulating across
 * steps, a reconnecting client would re-render all prior steps' text as one
 * duplicated blob after the structured history (the kimi-web "giant text
 * blob" bug).
 */

import { describe, expect, it } from 'vitest';

import { InFlightTurnTracker } from '#/services/gateway/inFlightTurnTracker';
import type { Event } from '@moonshot-ai/protocol';

const SID = 'session_1';
const MAIN = 'main';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: MAIN, ...partial } as unknown as Event;
}

describe('InFlightTurnTracker', () => {
  it('resets assistant/thinking accumulation at each turn.step.started', () => {
    const tracker = new InFlightTurnTracker();
    tracker.apply(SID, ev({ type: 'turn.started', turnId: 0 }));

    // Step 1 streams, then completes.
    tracker.apply(SID, ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
    tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'step one text ' }));
    tracker.apply(SID, ev({ type: 'thinking.delta', turnId: 0, delta: 'step one think ' }));
    tracker.apply(SID, ev({ type: 'turn.step.completed', turnId: 0, step: 1 }));

    // Step 2 begins — step 1's text/thinking now belong to the transcript.
    tracker.apply(SID, ev({ type: 'turn.step.started', turnId: 0, step: 2 }));
    tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'step two text' }));

    const snap = tracker.get(SID);
    expect(snap?.assistant_text).toBe('step two text');
    expect(snap?.thinking_text).toBe('');
  });

  it('stamps step-relative offsets on delta frames', () => {
    const tracker = new InFlightTurnTracker();
    tracker.apply(SID, ev({ type: 'turn.started', turnId: 0 }));
    tracker.apply(SID, ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
    expect(tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'abcde' })).offset).toBe(0);
    expect(tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'fg' })).offset).toBe(5);

    // After a step boundary the offset restarts from 0.
    tracker.apply(SID, ev({ type: 'turn.step.started', turnId: 0, step: 2 }));
    expect(tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'x' })).offset).toBe(0);
    expect(tracker.apply(SID, ev({ type: 'thinking.delta', turnId: 0, delta: 'yy' })).offset).toBe(0);
  });

  it('keeps running tool calls across the accumulation reset until their result', () => {
    const tracker = new InFlightTurnTracker();
    tracker.apply(SID, ev({ type: 'turn.started', turnId: 0 }));
    tracker.apply(SID, ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
    tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'working' }));
    tracker.apply(SID, ev({ type: 'tool.call.started', turnId: 0, toolCallId: 'Bash_0', name: 'Bash', args: { command: 'ls' } }));

    const snap = tracker.get(SID);
    expect(snap?.running_tools.map((t) => t.tool_call_id)).toEqual(['Bash_0']);

    tracker.apply(SID, ev({ type: 'tool.result', turnId: 0, toolCallId: 'Bash_0', output: 'ok' }));
    expect(tracker.get(SID)?.running_tools).toEqual([]);
  });

  it('ignores subagent frames and clears on turn.ended', () => {
    const tracker = new InFlightTurnTracker();
    tracker.apply(SID, { type: 'turn.started', turnId: 0, agentId: 'sub_1' } as unknown as Event);
    expect(tracker.get(SID)).toBeNull();

    tracker.apply(SID, ev({ type: 'turn.started', turnId: 0 }));
    tracker.apply(SID, ev({ type: 'assistant.delta', turnId: 0, delta: 'text' }));
    expect(tracker.get(SID)?.assistant_text).toBe('text');
    tracker.apply(SID, ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    expect(tracker.get(SID)).toBeNull();
  });
});
