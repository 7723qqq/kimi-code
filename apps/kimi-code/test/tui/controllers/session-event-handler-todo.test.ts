import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import type { ToolCallBlockData } from '#/tui/types';

function makeHarness() {
  const activeCalls = new Map<string, ToolCallBlockData>();
  const streamingUI = {
    setTurnId: mock(),
    flushNow: mock(),
    getTurnContext: mock(() => ({ turnId: 1, step: 0 })),
    registerToolCall: mock((call: ToolCallBlockData) => {
      activeCalls.set(call.id, call);
      return true;
    }),
    completeToolResult: mock((toolCallId: string) => {
      const call = activeCalls.get(toolCallId);
      activeCalls.delete(toolCallId);
      return call;
    }),
    setTodoList: mock(),
  };
  const todoRegion = {
    setTodos: mock(),
    clear: mock(),
  };
  const host = {
    state: {
      appState: { availableModels: {}, workDir: '/tmp/work', stepRetry: null },
      ui: { requestRender: mock() },
      transcriptContainer: { addChild: mock() },
      todoRegion,
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
  return { handler, streamingUI, todoRegion };
}

function todoCallStarted(toolCallId: string, todos: unknown): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'tool.call.started',
    turnId: 1,
    toolCallId,
    name: 'TodoList',
    args: { todos },
  } as unknown as Event;
}

function todoResult(toolCallId: string, isError = false): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'tool.result',
    turnId: 1,
    toolCallId,
    output: 'ok',
    isError,
  } as unknown as Event;
}

function todoUpdated(todos: unknown, agentId = 'main'): Event {
  return {
    sessionId: 's1',
    agentId,
    type: 'todo.updated',
    turnId: 1,
    todos,
    rev: 1,
  } as unknown as Event;
}

const item = {
  id: 'T1',
  parentId: null,
  kind: 'task' as const,
  title: 'real work',
  status: 'in_progress' as const,
};

describe('SessionEventHandler — todo panel feed', () => {
  it('ignores the TodoList tool arguments entirely', () => {
    const { handler, todoRegion } = makeHarness();

    handler.handleEvent(todoCallStarted('tc-1', [item]), mock());
    handler.handleEvent(todoResult('tc-1'), mock());

    // Reading the tool arguments is what used to clear the panel on a
    // read-only call (no `todos` key) and to hide a list the engine had
    // written without a tool call. The engine event is the only source now.
    expect(todoRegion.setTodos).not.toHaveBeenCalled();
  });

  it('feeds the region from the engine event, keeping every field', () => {
    const { handler, todoRegion } = makeHarness();
    const full = {
      id: 'M1',
      parentId: null,
      kind: 'milestone' as const,
      title: 'phase',
      status: 'pending' as const,
      progress: 40,
      description: 'note',
    };

    handler.handleEvent(todoUpdated([full]), mock());

    expect(todoRegion.setTodos).toHaveBeenCalledWith([full]);
  });

  it('applies an empty list, which is how a clear arrives', () => {
    const { handler, todoRegion } = makeHarness();

    handler.handleEvent(todoUpdated([]), mock());

    expect(todoRegion.setTodos).toHaveBeenCalledWith([]);
  });

  it('ignores another agent\'s list', () => {
    const { handler, todoRegion } = makeHarness();

    handler.handleEvent(todoUpdated([item], 'agent-1'), mock());

    expect(todoRegion.setTodos).not.toHaveBeenCalled();
  });
});
