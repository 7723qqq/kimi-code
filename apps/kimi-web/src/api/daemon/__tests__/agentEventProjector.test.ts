// apps/kimi-web/src/api/daemon/__tests__/agentEventProjector.test.ts
//
// End-to-end unit test: feeds the projector a real captured sequence of raw
// agent-core events, runs the resulting AppEvents through reduceAppEvent, and
// asserts on the final KimiClientState.

import { describe, expect, it } from 'vitest';
import { classifyFrame, createAgentProjector, isRawAgentCoreEvent } from '../agentEventProjector';
import { createInitialState, reduceAppEvent } from '../eventReducer';
import { toAppEvent } from '../mappers';
import type { AppEvent, AppMessage } from '../../types';

// ---------------------------------------------------------------------------
// Helper: feed events through projector + reducer
// ---------------------------------------------------------------------------

interface RawEvent {
  type: string;
  payload: unknown;
}

function runSequence(sessionId: string, rawEvents: RawEvent[]) {
  const projector = createAgentProjector();
  let state = createInitialState();

  // Pre-populate the session in state so sessionStatusChanged / sessionUsageUpdated
  // have something to mutate (the reducer silently ignores unknown session ids for
  // these events, so we seed a minimal session).
  const dummySession = {
    id: sessionId,
    title: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'idle' as const,
    cwd: '/',
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
  state = reduceAppEvent(
    state,
    { type: 'sessionCreated', session: dummySession },
    { sessionId, seq: 0 },
  );

  let seq = 1;
  const allAppEvents: AppEvent[] = [];

  for (const raw of rawEvents) {
    const appEvents = projector.project(raw.type, raw.payload, sessionId);
    for (const appEvent of appEvents) {
      allAppEvents.push(appEvent);
      state = reduceAppEvent(state, appEvent, { sessionId, seq: seq++ });
    }
  }

  return { state, allAppEvents };
}

/**
 * Mirror the real ws.ts routing: classify each incoming frame, then either
 * project it (agent path, using the prefix-stripped type) or run it through
 * toAppEvent() (protocol path). This exercises the "event."-prefix handling.
 */
function runFramesThroughRouting(sessionId: string, frames: RawEvent[]) {
  const projector = createAgentProjector();
  let state = createInitialState();

  const dummySession = {
    id: sessionId,
    title: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'idle' as const,
    cwd: '/',
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
  state = reduceAppEvent(
    state,
    { type: 'sessionCreated', session: dummySession },
    { sessionId, seq: 0 },
  );

  let seq = 1;
  const allAppEvents: AppEvent[] = [];

  for (const frame of frames) {
    const decision = classifyFrame(frame.type, frame.payload);
    if (decision.route === 'agent') {
      const appEvents = projector.project(decision.agentType, frame.payload, sessionId);
      for (const appEvent of appEvents) {
        allAppEvents.push(appEvent);
        state = reduceAppEvent(state, appEvent, { sessionId, seq: seq++ });
      }
    } else if (decision.route === 'protocol') {
      // toAppEvent expects a full wire frame; build a minimal one.
      const wireFrame = {
        type: frame.type,
        seq: seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        payload: frame.payload,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const appEvent = toAppEvent(wireFrame);
      allAppEvents.push(appEvent);
      state = reduceAppEvent(state, appEvent, { sessionId, seq: seq++ });
    }
  }

  return { state, allAppEvents };
}

// ---------------------------------------------------------------------------
// Captured sequence (real daemon shape)
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_test_001';
const TURN_ID = 42;

const capturedSequence: RawEvent[] = [
  {
    type: 'turn.started',
    payload: {
      type: 'turn.started',
      turnId: TURN_ID,
      origin: { kind: 'user' },
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'turn.step.started',
    payload: {
      type: 'turn.step.started',
      turnId: TURN_ID,
      step: 0,
      stepId: 'step_001',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'thinking.delta',
    payload: {
      type: 'thinking.delta',
      turnId: TURN_ID,
      delta: 'We',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'assistant.delta',
    payload: {
      type: 'assistant.delta',
      turnId: TURN_ID,
      delta: '我是',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'assistant.delta',
    payload: {
      type: 'assistant.delta',
      turnId: TURN_ID,
      delta: 'Kimi',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'turn.step.completed',
    payload: {
      type: 'turn.step.completed',
      turnId: TURN_ID,
      step: 0,
      stepId: 'step_001',
      usage: {
        inputOther: 1200,
        output: 80,
        inputCacheRead: 400,
        inputCacheCreation: 0,
      },
      finishReason: 'end_turn',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'agent.status.updated',
    payload: {
      type: 'agent.status.updated',
      model: 'moonshot-v1-128k',
      contextTokens: 8500,
      maxContextTokens: 131072,
      contextUsage: 0.065,
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'turn.ended',
    payload: {
      type: 'turn.ended',
      turnId: TURN_ID,
      reason: 'completed',
      agentId: 'main',
      sessionId: SESSION_ID,
    },
  },
  {
    type: 'prompt.completed',
    payload: {
      type: 'prompt.completed',
      agentId: 'main',
      sessionId: SESSION_ID,
      promptId: 'pr_test',
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAgentProjector', () => {
  it('projects the captured sequence: session ends idle', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session).toBeDefined();
    expect(session!.status).toBe('idle');
  });

  it('projects the captured sequence: assistant message contains "我是Kimi"', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const msgs: AppMessage[] = state.messagesBySession[SESSION_ID] ?? [];
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);

    // Find a message whose text content contains the expected string
    const hasText = assistantMsgs.some((m) =>
      m.content.some(
        (c) => c.type === 'text' && (c as { type: 'text'; text: string }).text.includes('我是Kimi'),
      ),
    );
    expect(hasText).toBe(true);
  });

  it('projects thinking delta into a thinking content block', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const msgs: AppMessage[] = state.messagesBySession[SESSION_ID] ?? [];
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
    const hasThinking = assistantMsgs.some((m) =>
      m.content.some(
        (c) => c.type === 'thinking' && (c as { type: 'thinking'; thinking: string }).thinking.includes('We'),
      ),
    );
    expect(hasThinking).toBe(true);
  });

  it('projects usage: context tokens updated', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session!.usage.contextTokens).toBe(8500);
    expect(session!.usage.contextLimit).toBe(131072);
  });

  it('projects the live model name from agent.status.updated onto the session', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session!.model).toBe('moonshot-v1-128k');
  });

  it('projects session.meta.updated title onto the session (sidebar refresh)', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'session.meta.updated',
      { type: 'session.meta.updated', agentId: 'main', title: 'Fix the login bug', patch: { title: 'Fix the login bug' } },
      SESSION_ID,
    );
    expect(events).toContainEqual({ type: 'sessionMetaUpdated', sessionId: SESSION_ID, title: 'Fix the login bug' });

    let state = createInitialState();
    state = reduceAppEvent(
      state,
      {
        type: 'sessionCreated',
        session: {
          id: SESSION_ID,
          title: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'idle',
          cwd: '/',
          model: '',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalCostUsd: 0,
            contextTokens: 0,
            contextLimit: 0,
            turnCount: 0,
          },
          messageCount: 0,
          lastSeq: 0,
        },
      },
      { sessionId: SESSION_ID, seq: 0 },
    );
    for (const e of events) state = reduceAppEvent(state, e, { sessionId: SESSION_ID, seq: 1 });
    expect(state.sessions.find((s) => s.id === SESSION_ID)!.title).toBe('Fix the login bug');
  });

  it('projects compaction.completed into a historyCompacted event (triggers reload)', () => {
    const projector = createAgentProjector();
    const events = projector.project(
      'compaction.completed',
      { type: 'compaction.completed', result: { summary: 's', compactedCount: 5, tokensBefore: 9000, tokensAfter: 2000 } },
      SESSION_ID,
    );
    const compacted = events.filter((e) => e.type === 'historyCompacted');
    expect(compacted).toHaveLength(1);
    expect((compacted[0] as { sessionId: string }).sessionId).toBe(SESSION_ID);
  });

  it('projects usage: turn count incremented', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session!.usage.turnCount).toBe(1);
  });

  it('projects usage: token counts from turn.step.completed', () => {
    const { state } = runSequence(SESSION_ID, capturedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session!.usage.inputTokens).toBe(1200);
    expect(session!.usage.outputTokens).toBe(80);
    expect(session!.usage.cacheReadTokens).toBe(400);
  });

  it('projects sessionStatusChanged running then idle', () => {
    const { allAppEvents } = runSequence(SESSION_ID, capturedSequence);
    const statusChanges = allAppEvents.filter((e) => e.type === 'sessionStatusChanged');
    const statuses = statusChanges.map((e) => (e as { type: 'sessionStatusChanged'; status: string }).status);
    expect(statuses).toContain('running');
    expect(statuses[statuses.length - 1]).toBe('idle');
  });

  it('emits messageCreated for the assistant turn', () => {
    const { allAppEvents } = runSequence(SESSION_ID, capturedSequence);
    const created = allAppEvents.filter((e) => e.type === 'messageCreated');
    expect(created.length).toBeGreaterThan(0);
    const hasAssistant = created.some(
      (e) => (e as { type: 'messageCreated'; message: AppMessage }).message.role === 'assistant',
    );
    expect(hasAssistant).toBe(true);
  });

  it('emits assistantDelta events for text', () => {
    const { allAppEvents } = runSequence(SESSION_ID, capturedSequence);
    const deltas = allAppEvents.filter((e) => e.type === 'assistantDelta');
    expect(deltas.length).toBeGreaterThan(0);
    const textDeltas = deltas.filter(
      (e) => (e as { type: 'assistantDelta'; delta: { text?: string } }).delta.text !== undefined,
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('never throws on unknown event types', () => {
    const projector = createAgentProjector();
    expect(() => {
      projector.project('totally.unknown.event.type', { foo: 'bar' }, 'ses_x');
    }).not.toThrow();
    expect(() => {
      projector.project('', null, 'ses_x');
    }).not.toThrow();
  });

  it('reset() clears per-session state', () => {
    const projector = createAgentProjector();
    // Start a turn
    projector.project('turn.started', { turnId: 1, agentId: 'main', sessionId: 'ses_r' }, 'ses_r');
    projector.project('turn.step.started', { turnId: 1, step: 0, stepId: 's1', agentId: 'main', sessionId: 'ses_r' }, 'ses_r');
    // Reset and start fresh — should not carry over the old assistant message id
    projector.reset('ses_r');
    const events = projector.project('assistant.delta', { turnId: 1, delta: 'hello', agentId: 'main', sessionId: 'ses_r' }, 'ses_r');
    // After reset there is no current assistant message, so delta is dropped
    expect(events.filter((e) => e.type === 'assistantDelta')).toHaveLength(0);
  });
});

describe('isRawAgentCoreEvent', () => {
  it('returns false for event.* frames', () => {
    expect(isRawAgentCoreEvent('event.assistant.delta')).toBe(false);
    expect(isRawAgentCoreEvent('event.session.status_changed')).toBe(false);
    expect(isRawAgentCoreEvent('event.message.created')).toBe(false);
  });

  it('returns false for control frames', () => {
    expect(isRawAgentCoreEvent('server_hello')).toBe(false);
    expect(isRawAgentCoreEvent('ack')).toBe(false);
    expect(isRawAgentCoreEvent('ping')).toBe(false);
    expect(isRawAgentCoreEvent('resync_required')).toBe(false);
    expect(isRawAgentCoreEvent('error')).toBe(false);
  });

  it('returns true for raw agent-core event types', () => {
    expect(isRawAgentCoreEvent('turn.started')).toBe(true);
    expect(isRawAgentCoreEvent('turn.step.started')).toBe(true);
    expect(isRawAgentCoreEvent('assistant.delta')).toBe(true);
    expect(isRawAgentCoreEvent('thinking.delta')).toBe(true);
    expect(isRawAgentCoreEvent('turn.ended')).toBe(true);
    expect(isRawAgentCoreEvent('agent.status.updated')).toBe(true);
    expect(isRawAgentCoreEvent('tool.call.started')).toBe(true);
    expect(isRawAgentCoreEvent('tool.result')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyFrame — routing of raw / prefixed / protocol frames
// ---------------------------------------------------------------------------

describe('classifyFrame', () => {
  it('routes unprefixed agent-core events to the agent projector', () => {
    expect(classifyFrame('turn.started', { turnId: 1 })).toEqual({
      route: 'agent',
      agentType: 'turn.started',
    });
    expect(classifyFrame('turn.ended', { reason: 'completed' })).toEqual({
      route: 'agent',
      agentType: 'turn.ended',
    });
  });

  it('strips "event." and routes prefixed agent-core events to the projector', () => {
    expect(classifyFrame('event.turn.started', { turnId: 1 })).toEqual({
      route: 'agent',
      agentType: 'turn.started',
    });
    expect(classifyFrame('event.turn.step.started', { turnId: 1 })).toEqual({
      route: 'agent',
      agentType: 'turn.step.started',
    });
    expect(classifyFrame('event.prompt.completed', {})).toEqual({
      route: 'agent',
      agentType: 'prompt.completed',
    });
  });

  it('keeps genuine protocol events on the protocol path', () => {
    expect(classifyFrame('event.message.created', { message: {} })).toEqual({ route: 'protocol' });
    expect(classifyFrame('event.session.status_changed', {})).toEqual({ route: 'protocol' });
    expect(classifyFrame('event.session.usage_updated', {})).toEqual({ route: 'protocol' });
  });

  it('keeps approval/question requests on the protocol path (drive the UI)', () => {
    expect(classifyFrame('event.approval.requested', {})).toEqual({ route: 'protocol' });
    expect(classifyFrame('event.question.requested', {})).toEqual({ route: 'protocol' });
  });

  it('disambiguates assistant.delta by payload shape', () => {
    // Raw agent-core: delta is a STRING → project.
    expect(classifyFrame('event.assistant.delta', { delta: '我是' })).toEqual({
      route: 'agent',
      agentType: 'assistant.delta',
    });
    expect(classifyFrame('assistant.delta', { delta: 'Kimi' })).toEqual({
      route: 'agent',
      agentType: 'assistant.delta',
    });
    // Protocol: delta is an object, or message_id/content_index present → protocol.
    expect(
      classifyFrame('event.assistant.delta', { message_id: 'm1', content_index: 0, delta: { text: 'x' } }),
    ).toEqual({ route: 'protocol' });
  });

  it('disambiguates thinking.delta by payload shape', () => {
    expect(classifyFrame('event.thinking.delta', { delta: 'We' })).toEqual({
      route: 'agent',
      agentType: 'thinking.delta',
    });
    expect(
      classifyFrame('event.thinking.delta', { message_id: 'm1', content_index: 0, delta: { thinking: 'x' } }),
    ).toEqual({ route: 'protocol' });
  });

  it('ignores control frames', () => {
    expect(classifyFrame('server_hello', {})).toEqual({ route: 'ignore' });
    expect(classifyFrame('ping', {})).toEqual({ route: 'ignore' });
  });
});

// ---------------------------------------------------------------------------
// "event."-prefixed agent-core sequence (newer daemon shape)
// ---------------------------------------------------------------------------

const prefixedSequence: RawEvent[] = [
  { type: 'event.turn.started', payload: { turnId: TURN_ID, agentId: 'main', sessionId: SESSION_ID } },
  { type: 'event.turn.step.started', payload: { turnId: TURN_ID, step: 0, stepId: 's1', agentId: 'main', sessionId: SESSION_ID } },
  { type: 'event.assistant.delta', payload: { turnId: TURN_ID, delta: '我是', agentId: 'main', sessionId: SESSION_ID } },
  { type: 'event.assistant.delta', payload: { turnId: TURN_ID, delta: 'Kimi', agentId: 'main', sessionId: SESSION_ID } },
  { type: 'event.turn.ended', payload: { turnId: TURN_ID, reason: 'completed', agentId: 'main', sessionId: SESSION_ID } },
  { type: 'event.prompt.completed', payload: { agentId: 'main', sessionId: SESSION_ID, promptId: 'pr_test' } },
];

describe('event.-prefixed agent-core routing', () => {
  it('projects the prefixed sequence: assistant text contains "我是Kimi"', () => {
    const { state } = runFramesThroughRouting(SESSION_ID, prefixedSequence);
    const msgs: AppMessage[] = state.messagesBySession[SESSION_ID] ?? [];
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const hasText = assistantMsgs.some((m) =>
      m.content.some(
        (c) => c.type === 'text' && (c as { type: 'text'; text: string }).text.includes('我是Kimi'),
      ),
    );
    expect(hasText).toBe(true);
  });

  it('projects the prefixed sequence: session ends idle', () => {
    const { state } = runFramesThroughRouting(SESSION_ID, prefixedSequence);
    const session = state.sessions.find((s) => s.id === SESSION_ID);
    expect(session).toBeDefined();
    expect(session!.status).toBe('idle');
  });
});
