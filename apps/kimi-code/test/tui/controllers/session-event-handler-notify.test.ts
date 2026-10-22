import { Container } from '@moonshot-ai/pi-tui';
import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { UpdatesRegion } from '#/tui/components/chrome/status-surface/regions/updates-region';
import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const notifyPanel = new NotifyPanelComponent();
  const host = {
    state: {
      notifyPanel,
      // The Updates panel is a region of the status surface; the controller
      // clears it through the region, which is also what decides whether the
      // strip occupies rows.
      updatesRegion: new UpdatesRegion(notifyPanel),
      notifyPanelContainer: new Container(),
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
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
      getTurnContext: mock(() => ({ turnId: '1', step: 0 })),
    },
    requireSession: mock(),
    noteSessionTurnStarted: mock(),
    setAppState: mock((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: mock(),
    resetLivePane: mock(),
    updateActivityPane: mock(),
    updateQueueDisplay: mock(),
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
    tasksBrowserController: {},
  };
  return { host: host as any };
}

function turnStarted(origin: Record<string, unknown>): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.started',
    turnId: 1,
    origin,
  } as unknown as Event;
}

function turnEnded(): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.ended',
    turnId: 1,
    reason: 'completed',
  } as unknown as Event;
}

describe('SessionEventHandler — update panel lifecycle', () => {
  it.each(['user', 'cron_job', 'background_task'])('clears old updates at a new main %s turn', (kind) => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.notifications.setEnabled(true);
    handler.notifications.handleEvent({ type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 0, toolCallId: 'n1', name: 'NotifyUser', args: { message: 'Earlier finding' } } as Event);
    handler.notifications.handleEvent({ type: 'tool.result', sessionId: 's1', agentId: 'main', turnId: 0, toolCallId: 'n1', output: 'Update shown to the user.' } as Event);
    handler.handleEvent(turnStarted({ kind }), mock());
    handler.handleEvent(turnEnded(), mock());
    expect(host.state.notifyPanel.getEntries().map((entry: { text: string }) => entry.text)).toEqual([]);
    expect(host.streamingUI.clearNotifyPanel).not.toHaveBeenCalled();
  });

  it('collects child notifications before child routing without changing the main turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.notifications.setEnabled(true);
    handler.handleEvent({ type: 'tool.call.started', sessionId: 's1', agentId: 'worker-1', turnId: 9, toolCallId: 'n1', name: 'NotifyUser', args: { message: 'Child finding' } } as Event, mock());
    handler.handleEvent({ type: 'tool.result', sessionId: 's1', agentId: 'worker-1', turnId: 9, toolCallId: 'n1', output: 'Update shown to the user.' } as Event, mock());
    expect(host.state.notifyPanel.getEntries()[0]).toMatchObject({ agentId: 'worker-1', text: 'Child finding' });
    expect(host.streamingUI.setTurnId).not.toHaveBeenCalled();
    expect(host.streamingUI.completeToolResult).not.toHaveBeenCalled();
  });
});
