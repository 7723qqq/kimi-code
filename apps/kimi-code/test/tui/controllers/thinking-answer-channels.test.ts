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
      appendThinkingDelta: vi.fn(),
      hasThinkingDraft: vi.fn(() => false),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
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
  return { host };
}

function delta(kind: 'thinking.delta' | 'assistant.delta', text: string) {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: kind,
    turnId: 1,
    delta: text,
  } as never;
}

// Captured from the opencode free tier (`.tmp/sse-dump.txt`, model
// mimo-v2.6-flash-free): the gateway streams the reasoning under the field
// `reasoning` and the answer under `content`, in separate frames, never
// mirrored. Frames 0-3 are thinking, 4-10 the answer.
const THINKING = [
  'The user asks:',
  ' "你是什么模型？用一句话',
  '回答。" (What model',
  ' are you? Answer in one sentence.)',
];
const ANSWER = [
  '我是',
  ' Kimi Code CLI，由',
  ' Moonshot AI 的',
  ' Kimi ',
  '大模型驱动的',
  '交互',
  '式编程助手。',
];

// Regression guard for the report "thinking content is emitted a second time
// into the body": the two channels must stay disjoint from the event handler
// down, so the rendered thinking block can only ever hold thinking text and the
// assistant message only the answer.
describe('SessionEventHandler — thinking vs answer channels', () => {
  it('routes each delta to exactly one channel', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host as never);

    for (const piece of THINKING) handler.handleEvent(delta('thinking.delta', piece), vi.fn());
    for (const piece of ANSWER) handler.handleEvent(delta('assistant.delta', piece), vi.fn());

    const think = host.streamingUI.appendThinkingDelta.mock.calls.map((c) => c[0]).join('');
    const body = host.streamingUI.appendAssistantDelta.mock.calls.map((c) => c[0]).join('');

    expect(think).toBe(THINKING.join(''));
    expect(body).toBe(ANSWER.join(''));
    // Neither channel may carry the other's text.
    expect(body).not.toContain('The user asks');
    expect(think).not.toContain('Kimi Code CLI');
  });
});
