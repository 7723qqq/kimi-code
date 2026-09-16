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

function turnEnded(error?: unknown) {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.ended',
    turnId: 1,
    reason: 'failed',
    ...(error === undefined ? {} : { error }),
  } as any;
}

describe('SessionEventHandler — failed turn reporting', () => {
  it('surfaces the engine error payload of a failed turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      turnEnded({
        code: 'provider.api_error',
        message: 'llm http status 400 Bad Request: invalid schema',
        retryable: false,
      }),
      vi.fn(),
    );

    expect(host.showError).toHaveBeenCalledWith(
      '[provider.api_error] llm http status 400 Bad Request: invalid schema',
    );
  });

  it('keeps the localized notice for a provider-filtered turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      turnEnded({
        code: 'provider.filtered',
        message: 'Provider safety policy blocked the response.',
        retryable: false,
      }),
      vi.fn(),
    );

    expect(host.showStatus).toHaveBeenCalledWith(
      'Turn stopped: provider safety policy blocked the response.',
      'error',
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('stays quiet when a failed turn carries no payload', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnEnded(), vi.fn());

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
