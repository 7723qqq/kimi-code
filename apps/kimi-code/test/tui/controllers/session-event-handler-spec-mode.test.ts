import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';

function makeHarness() {
  const streamingUI = {
    setTurnId: mock(),
    flushNow: mock(),
    getTurnContext: mock(() => ({ turnId: 1, step: 0 })),
    registerToolCall: mock(() => true),
    completeToolResult: mock(),
    setTodoList: mock(),
  };
  const host = {
    state: {
      appState: { availableModels: {}, workDir: '/tmp/work', stepRetry: null },
      ui: { requestRender: mock() },
      transcriptContainer: { addChild: mock() },
    },
    session: undefined,
    streamingUI,
    appendTranscriptEntry: mock(),
    patchLivePane: mock(),
    setAppState: mock(),
    btwPanelController: { routeEvent: mock(() => false) },
    surveyController: {
      notifyToolCallStarted: mock(),
      notifyToolCallEnded: mock(),
      notifySubagentSpawned: mock(),
    },
    updateActivityPane: mock(),
    showStatus: mock(),
    noteSessionToolCompleted: mock(),
    noteSessionTurnStarted: mock(),
    noteSessionStepCompleted: mock(),
    noteStepUsage: mock(),
    noteStepCacheStats: mock(),
    noteCompactionFinished: mock(),
    recordSessionActivity: mock(),
  };
  const handler = new SessionEventHandler(host as never);
  return { handler, host };
}

function statusUpdate(fields: Record<string, unknown>): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'agent.status.updated',
    ...fields,
  } as unknown as Event;
}

describe('spec mode status updates', () => {
  it('clears the spec stage when spec mode is left', () => {
    const { handler, host } = makeHarness();

    handler.handleEvent(statusUpdate({ specMode: false }), mock());

    // The footer renders `spec:${stage}`; leaving the old stage behind would
    // label the next spec with the previous one's progress.
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ specMode: false, specStage: undefined }),
    );
  });

  it('does not touch the stage when spec mode is entered', () => {
    const { handler, host } = makeHarness();

    handler.handleEvent(statusUpdate({ specMode: true }), mock());

    const patch = host.setAppState.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['specMode']).toBe(true);
    expect('specStage' in patch).toBe(false);
  });
});
