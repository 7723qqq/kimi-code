import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { StreamingUIController } from '#/tui/controllers/streaming-ui';
import { getBuiltInPalette } from '#/tui/theme';

function makeUI() {
  const host = {
    state: {
      appState: { streamingPhase: 'thinking' },
      transcriptContainer: { addChild: vi.fn() },
      theme: { palette: undefined },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(() => undefined),
    pushTranscriptEntry: vi.fn(),
    mergeCurrentTurnSteps: vi.fn(),
    mergeCompletedTurnAssistants: vi.fn(),
  };
  return { host, ui: new StreamingUIController(host as never) };
}

// The tool-boundary regression: a step's reasoning used to stay in
// `_thinkingDraft` across a tool call, so the next step's identical reasoning
// appended to the same buffer and the block rendered it twice. These assert the
// buffer is actually emptied at the boundary — the existing
// session-event-handler tests mock this method away and cannot see it.
describe('StreamingUIController.finalizeLiveTextBuffers', () => {
  it('empties both drafts so the next step starts from a clean buffer', () => {
    const { ui } = makeUI();
    ui.appendThinkingDelta('first step reasoning');
    expect(ui.hasThinkingDraft()).toBe(true);

    ui.finalizeLiveTextBuffers('tool');

    // The boundary is the whole point: an empty draft is what stops the
    // second step from concatenating onto the first.
    expect(ui.hasThinkingDraft()).toBe(false);
  });

  it('carries no leftover text into a following step', () => {
    const { ui } = makeUI();
    ui.appendThinkingDelta('step one');
    ui.finalizeLiveTextBuffers('tool');
    ui.appendThinkingDelta('step two');
    ui.finalizeLiveTextBuffers('waiting');

    // Both steps were flushed; neither may leave a draft behind.
    expect(ui.hasThinkingDraft()).toBe(false);
  });

  it('passes the live-pane mode through so the pane state is not left stale', () => {
    const { host, ui } = makeUI();
    ui.appendThinkingDelta('x');
    ui.finalizeLiveTextBuffers('tool');
    expect(host.patchLivePane).toHaveBeenCalledWith({ mode: 'tool' });
  });

  it('is safe to call with nothing buffered', () => {
    const { host, ui } = makeUI();
    expect(() => ui.finalizeLiveTextBuffers('idle')).not.toThrow();
    expect(host.updateActivityPane).toHaveBeenCalled();
  });
});

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'thinking',
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
      completeToolResult: vi.fn(() => undefined),
      getTurnContext: vi.fn(() => ({ turnId: 'turn-1', step: 1 })),
      registerToolCall: vi.fn(),
      setTodoList: vi.fn(),
      appendThinkingDelta: vi.fn(),
      hasThinkingDraft: vi.fn(() => false),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      accumulateToolCallDelta: vi.fn(),
      getStreamingToolCallPreview: vi.fn(() => undefined),
      getToolComponent: vi.fn(() => undefined),
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
    subAgentEventHandler: {
      handleAgentSwarmToolCallStarted: vi.fn(),
      handleAgentSwarmToolCallDelta: vi.fn(),
      handleAgentSwarmToolResult: vi.fn(),
      hasAgentSwarmProgress: vi.fn(() => false),
    },
    surveyController: {
      notifyToolCallStarted: vi.fn(),
      notifyToolCallEnded: vi.fn(),
      notifySubagentSpawned: vi.fn(),
    },
  };
  return { host: host as any };
}

const toolCallStarted = {
  type: 'tool.call.started',
  sessionId: 's1',
  agentId: 'main',
  turnId: 1,
  toolCallId: 'tc1',
  name: 'Bash',
  args: { command: 'ls' },
} as const;

const toolResult = {
  type: 'tool.result',
  sessionId: 's1',
  agentId: 'main',
  turnId: 1,
  toolCallId: 'tc1',
  output: 'ok',
  isError: false,
} as const;

// Regression guard for "the thinking block renders the same text twice".
//
// A tool call ends the step's live text, so the handler has to SETTLE it and
// clear the draft — `finalizeLiveTextBuffers` — not merely push the draft into
// the component, which is all `flushNow` does. With `flushNow` the next step's
// reasoning kept appending to the same component and the same `_thinkingDraft`;
// because consecutive steps reason about a task the tool result has not changed
// yet, the appended text was the same text, and the block showed it twice.
describe('SessionEventHandler — the tool boundary settles live text', () => {
  it('finalizes the thinking block when a tool call starts', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolCallStarted as never, vi.fn());

    expect(host.streamingUI.finalizeLiveTextBuffers).toHaveBeenCalledWith('tool');
    expect(host.streamingUI.flushNow).not.toHaveBeenCalled();
  });

  it('finalizes the thinking block when a tool result lands', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolResult as never, vi.fn());

    expect(host.streamingUI.finalizeLiveTextBuffers).toHaveBeenCalledWith('waiting');
    expect(host.streamingUI.flushNow).not.toHaveBeenCalled();
  });

  it('still opens the tool pane when the call starts', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(toolCallStarted as never, vi.fn());

    expect(host.patchLivePane).toHaveBeenCalledWith({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  });
});

// Regression guard for shredded output when subagents run in parallel: the
// engine stamps a subagent's deltas with a `subturn-` turn id and the host
// attributes them to the active subagent, but the TUI used to append them to
// the main transcript's single `_thinkingDraft` anyway — so the main agent's
// reasoning and every subagent's reasoning interleaved chunk by chunk.
describe('SessionEventHandler — subagent deltas stay out of the main transcript', () => {
  const delta = (kind: 'thinking.delta' | 'assistant.delta', agentId: string, text: string) =>
    ({ type: kind, sessionId: 's1', agentId, turnId: 1, delta: text }) as never;

  it('drops a subagent thinking delta', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(delta('thinking.delta', 'subagent-1', 'subagent reasoning'), vi.fn());

    expect(host.streamingUI.appendThinkingDelta).not.toHaveBeenCalled();
  });

  it('drops a subagent assistant delta', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(delta('assistant.delta', 'subagent-1', 'subagent body'), vi.fn());

    expect(host.streamingUI.appendAssistantDelta).not.toHaveBeenCalled();
  });

  it('still routes the main agent on both channels', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(delta('thinking.delta', 'main', 'main reasoning'), vi.fn());
    handler.handleEvent(delta('assistant.delta', 'main', 'main body'), vi.fn());

    expect(host.streamingUI.appendThinkingDelta).toHaveBeenCalledWith('main reasoning');
    expect(host.streamingUI.appendAssistantDelta).toHaveBeenCalledWith('main body');
  });
});
