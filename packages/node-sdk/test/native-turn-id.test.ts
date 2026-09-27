/**
 * Scenario: the turn id the SDK derives from the engine's turn events.
 * Responsibilities: `normalizeEngineTurnId`'s id matrix, and the ids the events
 *   the SDK synthesizes actually carry once the engine's own id shape is fed
 *   through the real `turnEvent` / `emitEvent` handlers.
 * Wiring: the engine module is mocked so the host callbacks the SDK registers
 *   are driven with synthetic engine payloads; everything downstream of them is
 *   the production code path.
 * Run: bunx vitest run packages/node-sdk/test/native-turn-id.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarnessNative, type Event, type KimiHarness } from '../src/index';
import { normalizeEngineTurnId } from '../src/native/sdk-rpc-client-native';

import { TEST_IDENTITY } from './test-identity';

interface EngineCallbacks {
  turnEvent?: (eventJson: string) => void;
  emitEvent?: (eventJson: string) => void;
}

const engine = vi.hoisted(() => ({ callbacks: undefined as EngineCallbacks | undefined }));

// The addon is a build artifact and the engine drives the turn by calling back
// into these two host seams, so a stub handle that hands them over is all the
// turn-id path needs — no native build, no model server, no wall clock.
vi.mock('@moonshot-ai/kimi-agent/session-handle', () => ({
  EngineSessionHandle: {
    create: (_params: unknown, callbacks: EngineCallbacks) => {
      engine.callbacks = callbacks;
      return Promise.resolve({
        enqueueTurn: () => Promise.resolve(1),
        turnOutcome: () => new Promise<void>(() => {}),
        getHistory: () => Promise.resolve({ messages: [] }),
        setHistory: () => Promise.resolve(),
        clearHistory: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      });
    },
  },
}));

/**
 * The engine mints turn ids as strings — `turn-<n>` on the event lane
 * (`EngineEvent::TurnStarted`) and `subturn-<rand>` on the subagent lane
 * (`subagent/manager.rs`) — while the protocol events type `turnId` as a
 * number. The SDK used `Number.parseInt`, which reads a *leading* digit run
 * only, so `turn-3` parsed to `NaN` and `NaN || 0` mapped every turn onto 0.
 *
 * These assert the **id values**, not the event names: the engine shipped
 * ids that collapsed onto 0 and an event-name-only assertion (see
 * `native-harness.test.ts`) is blind to that.
 */
describe('normalizeEngineTurnId', () => {
  it('takes the numeric tail of a prefixed engine turn id', () => {
    expect(normalizeEngineTurnId('turn-3')).toBe(3);
    // The prefix is not part of the identity: the transcript fold re-keys both
    // shapes off the number alone (`turn_key` → `t<number>`), so a subturn's
    // id is its turn's number, not a second namespace.
    expect(normalizeEngineTurnId('subturn-7')).toBe(7);
  });

  it('passes a numeric id through unchanged', () => {
    expect(normalizeEngineTurnId(3)).toBe(3);
    expect(normalizeEngineTurnId(0)).toBe(0);
    expect(normalizeEngineTurnId('3')).toBe(3);
  });

  it('degrades an unparseable id to the documented fallback, never NaN', () => {
    // 0 is the "no turn known" value `meta.currentTurnId` starts at. What the
    // old `Number.parseInt(raw, 10) || 0` could not promise is a *defined*
    // value: `turn-3` parsed to NaN there, and `NaN || 0` turning every turn
    // into turn 0 is invisible precisely because 0 is also the initial value.
    for (const raw of ['abc', '', 'turn-', '-', 'subturn-', undefined, null, {}, []]) {
      const id = normalizeEngineTurnId(raw);
      expect(id).toBe(0);
      expect(Number.isNaN(id)).toBe(false);
    }
  });

  it('keeps a real turn 0 and a later turn apart', () => {
    expect(normalizeEngineTurnId('turn-0')).toBe(0);
    expect(normalizeEngineTurnId('turn-1')).not.toBe(normalizeEngineTurnId('turn-2'));
  });
});

/** An event reduced to the fields the turn-id assertions read. */
interface SeenEvent {
  readonly type: string;
  readonly turnId: unknown;
}

describe('turn ids in the events the SDK emits', () => {
  const dirs: string[] = [];
  let harness: KimiHarness;
  let seen: SeenEvent[];

  beforeEach(async () => {
    engine.callbacks = undefined;
    seen = [];
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-sdk-turn-id-'));
    dirs.push(homeDir);
    harness = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({ workDir: homeDir });
    session.onEvent((event: Event) => {
      seen.push({ type: event.type, turnId: (event as { turnId?: unknown }).turnId });
    });
  });

  afterEach(async () => {
    await harness.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** Feed one engine turn-lifecycle record through the real `turnEvent` seam. */
  const turnEvent = (payload: Record<string, unknown>): void => {
    const send = engine.callbacks?.turnEvent;
    if (send === undefined) throw new Error('the session registered no turnEvent callback');
    send(JSON.stringify(payload));
  };

  /** Feed one engine event through the real `emitEvent` seam. */
  const emitEvent = (payload: Record<string, unknown>): void => {
    const send = engine.callbacks?.emitEvent;
    if (send === undefined) throw new Error('the session registered no emitEvent callback');
    send(JSON.stringify(payload));
  };

  /**
   * Run one synthetic turn: a `turn.started` carrying `rawTurnId`, then the
   * step boundaries the turn loop emits, and hand back the events the host
   * emitted for it. `llm.step.begin` / `llm.step.end` name no turn of their
   * own — the SDK stamps them from `meta.currentTurnId`, which is exactly the
   * value the `turn.started` id has to land in.
   */
  const runTurn = (rawTurnId: unknown): SeenEvent[] => {
    turnEvent({ type: 'turn.started', turn_id: rawTurnId, origin: { kind: 'user' } });
    emitEvent({ type: 'llm.step.begin' });
    emitEvent({ type: 'llm.step.end', turn_id: rawTurnId, step: 1 });
    turnEvent({ type: 'turn.ended', reason: 'completed' });
    const events = seen;
    seen = [];
    return events;
  };

  /** `[type, turnId]` per event, so an expectation names both. */
  const idsOf = (events: SeenEvent[]): Array<[string, unknown]> =>
    events.map((event) => [event.type, event.turnId]);

  /** The four events one of these turns emits, all addressed to `id`. */
  const turnAddressing = (id: number): Array<[string, unknown]> => [
    ['turn.started', id],
    ['turn.step.started', id],
    ['turn.step.completed', id],
    ['turn.ended', id],
  ];

  it('addresses a turn-<n> id to that turn, not to turn 0', () => {
    expect(idsOf(runTurn('turn-3'))).toEqual(turnAddressing(3));
    // A second turn must not reuse the first one's id: with the leading-digit
    // parse both arrived as 0, so every turn after the first was filed under
    // turn 0 and a client grouping by turn folded the session into one.
    expect(idsOf(runTurn('turn-4'))).toEqual(turnAddressing(4));
  });

  it('reads the number out of a subturn-<n> id', () => {
    expect(idsOf(runTurn('subturn-7'))).toEqual(turnAddressing(7));
  });

  it('leaves a numeric id unchanged', () => {
    expect(idsOf(runTurn(12))).toEqual(turnAddressing(12));
    expect(idsOf(runTurn(0))).toEqual(turnAddressing(0));
  });

  it('falls back to turn 0 for an id it cannot read', () => {
    expect(idsOf(runTurn('not-a-turn'))).toEqual(turnAddressing(0));
  });

  it('carries the current turn on an event that names none', () => {
    // `turn.ended` without an id must fall back to the turn in flight, not to
    // a fresh 0 — the same defined-value rule as the parse above.
    turnEvent({ type: 'turn.started', turn_id: 'turn-9', origin: { kind: 'user' } });
    emitEvent({ type: 'llm.step.begin' });
    turnEvent({ type: 'turn.ended', reason: 'completed' });
    expect(idsOf(seen)).toEqual([
      ['turn.started', 9],
      ['turn.step.started', 9],
      ['turn.ended', 9],
    ]);
  });
});
