import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';

function makeHarness() {
  const streamingUI = {
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    registerToolCall: vi.fn(() => true),
    completeToolResult: vi.fn(),
    setTodoList: vi.fn(),
  };
  const host = {
    state: {
      appState: { availableModels: {}, workDir: '/tmp/work', stepRetry: null },
      ui: { requestRender: vi.fn() },
      transcriptContainer: { addChild: vi.fn() },
    },
    session: undefined,
    streamingUI,
    appendTranscriptEntry: vi.fn(),
    patchLivePane: vi.fn(),
    setAppState: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    surveyController: {
      notifyToolCallStarted: vi.fn(),
      notifyToolCallEnded: vi.fn(),
      notifySubagentSpawned: vi.fn(),
    },
    updateActivityPane: vi.fn(),
    showStatus: vi.fn(),
    noteSessionToolCompleted: vi.fn(),
    noteSessionTurnStarted: vi.fn(),
    noteSessionStepCompleted: vi.fn(),
    noteStepUsage: vi.fn(),
    noteStepCacheStats: vi.fn(),
    noteCompactionFinished: vi.fn(),
    recordSessionActivity: vi.fn(),
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

    handler.handleEvent(statusUpdate({ specMode: false }), vi.fn());

    // The footer renders `spec:${stage}`; leaving the old stage behind would
    // label the next spec with the previous one's progress.
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ specMode: false, specStage: undefined }),
    );
  });

  it('does not touch the stage when spec mode is entered', () => {
    const { handler, host } = makeHarness();

    handler.handleEvent(statusUpdate({ specMode: true }), vi.fn());

    const patch = host.setAppState.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch['specMode']).toBe(true);
    expect('specStage' in patch).toBe(false);
  });
});
