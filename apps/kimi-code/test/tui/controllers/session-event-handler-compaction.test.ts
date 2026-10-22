import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        isCompacting: true,
        model: 'kimi-model',
        permissionMode: 'auto',
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
      flushNow: mock(),
      resetToolUi: mock(),
      clearNotifyPanel: mock(),
      markNotifyPanelEnded: mock(),
      finalizeTurn: mock(),
      hasActiveTurn: mock(() => false),
      hasThinkingDraft: mock(() => false),
      flushThinkingToTranscript: mock(),
      appendAssistantDelta: mock(),
      scheduleFlush: mock(),
      beginCompaction: mock(),
      endCompaction: mock(),
      cancelCompaction: mock(),
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
    noteCompactionFinished: mock(),
    mountEditorReplacement: mock(),
    restoreEditor: mock(),
    restoreInputText: mock(),
    appendTranscriptEntry: mock(),
    sendNormalUserInput: mock(),
    sendQueuedMessage: mock(),
    shiftQueuedMessage: mock(),
    btwPanelController: { routeEvent: mock(() => false) },
    surveyController: { notifyCompactionFinished: mock() },
    tasksBrowserController: {},
  };
  return { host: host as any };
}

const compactionCompleted = {
  type: 'compaction.completed',
  sessionId: 's1',
  agentId: 'main',
  result: { summary: 'summary', tokensBefore: 100, tokensAfter: 10, compactedCount: 1 },
} as const;

const compactionCancelled = {
  type: 'compaction.cancelled',
  sessionId: 's1',
  agentId: 'main',
} as const;

describe('SessionEventHandler compaction cache bookkeeping', () => {
  it('records activity and resets the cache-break baseline after a completed compaction', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(compactionCompleted, mock());
    expect(host.recordSessionActivity).toHaveBeenCalledTimes(1);
    expect(host.noteCompactionFinished).toHaveBeenCalledTimes(1);
  });

  it('keeps both baselines after a cancelled compaction (context was not cut)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(compactionCancelled, mock());
    expect(host.noteCompactionFinished).not.toHaveBeenCalled();
    expect(host.recordSessionActivity).not.toHaveBeenCalled();
  });
});
