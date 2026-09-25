import { describe, expect, it } from 'vitest';

import { createAgentProjector } from './agentEventProjector';

// v2 `TurnCancel` (`agent/loop/turnOps.ts`). A turn cancelled while still
// queued never starts, so it emits **no** `turn.ended` — this event is its
// only terminal signal. Before it was projected, the working moon and the
// composer stayed stuck forever after such a cancel.
describe('turn.cancel projection', () => {
  it('clears the main turn when a queued turn is cancelled', () => {
    const projector = createAgentProjector();

    const events = projector.project(
      'turn.cancel',
      { turnId: 4, target: 'queued', reason: 'user_cancelled' },
      'sess-1',
    );

    expect(events).toEqual([
      { type: 'turnActiveChanged', sessionId: 'sess-1', active: false, reason: 'cancelled' },
    ]);
  });

  it('leaves the active target to its own turn.ended', () => {
    const projector = createAgentProjector();

    // That turn is still running; its `turn.ended(cancelled)` closes it. Acting
    // here would finish the same turn twice.
    expect(projector.project('turn.cancel', { turnId: 4, target: 'active' }, 'sess-1')).toEqual([]);
    expect(projector.project('turn.cancel', { turnId: 4 }, 'sess-1')).toEqual([]);
  });
});
