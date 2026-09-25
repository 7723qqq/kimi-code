import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

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
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      clearNotifyPanel: vi.fn(),
      markNotifyPanelEnded: vi.fn(),
      finalizeTurn: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      completeToolResult: vi.fn(),
      setTodoList: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteStepCacheStats: vi.fn(),
    noteSessionTurnStarted: vi.fn(),
    noteSessionStepCompleted: vi.fn(),
    noteSessionToolCompleted: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
    updateActivityPane: vi.fn(),
  };
  return { host: host as any };
}

function turnCancel(target?: 'active' | 'queued') {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.cancel',
    turnId: 2,
    ...(target === undefined ? {} : { target }),
    reason: 'user_cancelled',
  } as any;
}

// v2 `TurnCancel` (`agent/loop/turnOps.ts`). A turn cancelled while still
// queued never starts, so it emits **no** `turn.ended` — this event is its only
// terminal signal. Without a handler the session stayed busy forever: the
// composer never came back and the busy indicator never stopped.
describe('SessionEventHandler — turn.cancel', () => {
  it('releases the composer when a queued turn is cancelled', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    const sendQueued = vi.fn();

    handler.handleEvent(turnCancel('queued'), sendQueued);

    expect(host.streamingUI.finalizeTurn).toHaveBeenCalledWith(sendQueued);
    expect(host.streamingUI.resetToolUi).toHaveBeenCalled();
    expect(host.recordSessionActivity).toHaveBeenCalled();
  });

  it('leaves the active target to its own turn.ended', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    // That turn is still running; finalizing here would close it twice.
    handler.handleEvent(turnCancel('active'), vi.fn());

    expect(host.streamingUI.finalizeTurn).not.toHaveBeenCalled();
  });

  it('does nothing when the cancel names no target', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnCancel(), vi.fn());

    expect(host.streamingUI.finalizeTurn).not.toHaveBeenCalled();
  });
});
