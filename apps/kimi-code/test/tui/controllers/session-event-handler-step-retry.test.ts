import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: mock(() => []) },
      transcriptContainer: { addChild: mock() },
      ui: { requestRender: mock() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: mock(),
      setStep: mock(),
      flushNow: mock(),
      resetToolUi: mock(),
      clearNotifyPanel: mock(),
      markNotifyPanelEnded: mock(),
      finalizeTurn: mock(),
      finalizeLiveTextBuffers: mock(),
      completeToolResult: mock(),
    },
    requireSession: mock(),
    setAppState: mock((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: mock(),
    resetLivePane: mock(),
    showError: mock(),
    showStatus: mock(),
    showNotice: mock(),
    track: mock(),
    recordSessionActivity: mock(),
    noteStepUsage: mock(),
    noteStepCacheStats: mock(),
    noteSessionTurnStarted: mock(),
    noteSessionStepCompleted: mock(),
    noteSessionToolCompleted: mock(),
    noteCompactionFinished: mock(),
    mountEditorReplacement: mock(),
    restoreEditor: mock(),
    restoreInputText: mock(),
    appendTranscriptEntry: mock(),
    sendNormalUserInput: mock(),
    sendQueuedMessage: mock(),
    shiftQueuedMessage: mock(),
    btwPanelController: { routeEvent: mock(() => false) },
    tasksBrowserController: {},
    updateActivityPane: mock(),
    surveyController: {
      notifyToolCallStarted: mock(),
      notifyToolCallEnded: mock(),
      notifySubagentSpawned: mock(),
    },
  };
  return { host: host as any };
}

const retryingEvent = {
  type: 'turn.step.retrying',
  sessionId: 's1',
  agentId: 'main',
  turnId: 1,
  step: 1,
  failedAttempt: 1,
  nextAttempt: 2,
  maxAttempts: 10,
  delayMs: 4000,
  errorName: 'APIStatusError',
  errorMessage: 'rate limited',
  statusCode: 429,
} as const;

describe('SessionEventHandler step retry state', () => {
  function makeRetryHandler(host: any, clock: FakeClock = createFakeClock()) {
    return { handler: new SessionEventHandler(host, undefined, clock), clock };
  }

  it('stores the retry snapshot when a step starts retrying', () => {
    const { host } = makeHost();
    const { handler } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    expect(host.state.appState.stepRetry).toEqual({
      nextAttempt: 2,
      maxAttempts: 10,
      delayMs: 4000,
      errorName: 'APIStatusError',
      errorMessage: 'rate limited',
      statusCode: 429,
      phase: 'backoff',
    });
  });

  it('drives the pane back to waiting so mid-stream retries render', () => {
    const { host } = makeHost();
    host.state.appState.streamingPhase = 'composing';
    const { handler } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    expect(host.patchLivePane).toHaveBeenCalledWith({ mode: 'waiting' });
    expect(host.state.appState.streamingPhase).toBe('waiting');
  });

  it.each([
    [{ type: 'turn.step.completed', turnId: 1, step: 1 }, 'turn.step.completed'],
    [
      { type: 'turn.step.interrupted', turnId: 1, step: 1, reason: 'error' },
      'turn.step.interrupted',
    ],
    [{ type: 'turn.ended', turnId: 1, reason: 'completed' }, 'turn.ended'],
    [
      { type: 'tool.result', turnId: 1, toolCallId: 'tc1', output: 'ok', isError: false },
      'tool.result',
    ],
  ])('clears the retry snapshot on %s', (event, _label) => {
    const { host } = makeHost();
    const { handler } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    expect(host.state.appState.stepRetry).not.toBeNull();
    handler.handleEvent({ sessionId: 's1', agentId: 'main', ...event } as any, mock());
    expect(host.state.appState.stepRetry).toBeNull();
  });

  it('flips to attempt phase once the backoff delay elapses', () => {
    const { host } = makeHost();
    const { handler, clock } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    expect(host.state.appState.stepRetry).toMatchObject({ phase: 'backoff' });
    clock.advance(4000);
    expect(host.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, phase: 'attempt' });
  });

  it('cancels the phase flip when the retry is cleared during the backoff', () => {
    const { host } = makeHost();
    const { handler, clock } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    handler.handleEvent(
      {
        type: 'turn.step.interrupted',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        step: 1,
        reason: 'error',
      } as any,
      mock(),
    );
    clock.advance(10_000);
    expect(host.state.appState.stepRetry).toBeNull();
  });

  it('keeps the retry snapshot on turn.step.started (v2 re-emits it per attempt)', () => {
    const { host } = makeHost();
    const { handler } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    handler.handleEvent(
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1 } as any,
      mock(),
    );
    expect(host.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, phase: 'backoff' });
  });

  it('cancels the pending phase flip via clearStepRetryAttemptTimer (TUI shutdown path)', () => {
    const { host } = makeHost();
    const { handler, clock } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    handler.clearStepRetryAttemptTimer();
    clock.advance(10_000);
    expect(host.state.appState.stepRetry).toMatchObject({ phase: 'backoff' });
  });

  it('clears the retry snapshot when the session runtime resets', () => {
    const { host } = makeHost();
    const { handler, clock } = makeRetryHandler(host);
    handler.handleEvent(retryingEvent as any, mock());
    expect(host.state.appState.stepRetry).not.toBeNull();

    // Switching sessions mid-backoff must drop both the pending phase-flip
    // timer and the stale retry appState.
    handler.resetRuntimeState();
    expect(host.state.appState.stepRetry).toBeNull();
    clock.advance(10_000);
    expect(host.state.appState.stepRetry).toBeNull();
  });
});
