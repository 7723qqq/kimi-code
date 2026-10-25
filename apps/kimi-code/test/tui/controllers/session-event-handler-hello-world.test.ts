import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';

interface TestComponent {
  render(width: number): string[];
}

function makeHarness(helloWorldStage?: string) {
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
      appState: {
        availableModels: {},
        workDir: '/tmp/work',
        stepRetry: null,
        helloWorldMode: true,
        helloWorldStage,
      },
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

function renderedMarker(host: { appendTranscriptEntry: unknown }): string {
  const calls = (host.appendTranscriptEntry as ReturnType<typeof mock>).mock.calls;
  const component = calls.at(-1)?.[1] as TestComponent | undefined;
  return component?.render(80).join('\n') ?? '';
}

describe('hello-world stage status updates', () => {
  it('renders a stage marker and syncs appState when helloWorldStage changes', () => {
    const { handler, host } = makeHarness();

    handler.handleEvent(statusUpdate({ helloWorldStage: 'design' }), mock());

    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ helloWorldStage: 'design' }),
    );
    expect(renderedMarker(host)).toContain('Hello-world stage: design');
  });

  it('does not render a stage marker when the stage is unchanged', () => {
    const { handler, host } = makeHarness('design');

    handler.handleEvent(statusUpdate({ helloWorldStage: 'design' }), mock());

    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('clears the stage when hello-world mode is left', () => {
    const { handler, host } = makeHarness('design');

    handler.handleEvent(statusUpdate({ helloWorldMode: false }), mock());

    // The footer renders `hello-world:${stage}`; leaving the old stage behind
    // would label the next run with the previous one's progress.
    expect(host.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ helloWorldMode: false, helloWorldStage: undefined }),
    );
  });
});
