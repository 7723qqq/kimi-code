import type { GoalChange } from '@moonshot-ai/kimi-code-sdk';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';

import { buildGoalMarker } from '#/tui/components/messages/goal-markers';
import { STATUS_DOT } from '#/tui/constant/symbols';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { readGoalQueue, removeGoalQueueItem, restoreGoalQueueItem } from '#/tui/goal-queue-store';
import { getBuiltInPalette } from '#/tui/theme';

void mock.module('#/tui/goal-queue-store', () => ({
  readGoalQueue: mock(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
  removeGoalQueueItem: mock(async () => ({ goals: [] })),
  restoreGoalQueueItem: mock(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
}));

const readGoalQueueMock = readGoalQueue as Mock<typeof readGoalQueue>;
const removeGoalQueueItemMock = removeGoalQueueItem as Mock<typeof removeGoalQueueItem>;
const restoreGoalQueueItemMock = restoreGoalQueueItem as Mock<typeof restoreGoalQueueItem>;

function fakeGoalSnapshot(objective: string, status: 'active' | 'blocked' | 'paused' | 'complete') {
  return {
    goalId: 'g1',
    objective,
    status,
    turnsUsed: 1,
    tokensUsed: 10,
    inputTokensUsed: 8,
    outputTokensUsed: 2,
    wallClockMs: 100,
    createdAt: 1000,
    updatedAt: 2000,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 19,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
      inputTokensUsed: 8,
      outputTokensUsed: 2,
    },
  };
}

function makeHost(options: { createGoalRejects?: boolean } = {}) {
  const session = {
    createGoal: mock(async () => {
      if (options.createGoalRejects === true) throw new Error('create failed');
      return fakeGoalSnapshot('Ship queued goal', 'active');
    }),
    cancelGoal: mock(async () => fakeGoalSnapshot('Ship queued goal', 'active')),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
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
    session,
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
      getTurnContext: mock(() => ({ turnId: 'turn-1', step: 0 })),
    },
    requireSession: mock(() => session),
    setAppState: mock(),
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
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  host.streamingUI.finalizeTurn.mockImplementation(() => {
    host.setAppState({ streamingPhase: 'idle' });
  });
  return { host: host as any, session };
}

function sendQueuedViaHost(host: ReturnType<typeof makeHost>['host'], session: unknown) {
  return (item: unknown) => {
    host.sendQueuedMessage(session as never, item as never);
  };
}

function completionEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Current goal', 'complete'),
    change: {
      kind: 'completion',
      status: 'complete',
      stats: { turnsUsed: 1, tokensUsed: 10, wallClockMs: 100 },
    },
  } as const;
}

function clearedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: null,
  } as const;
}

function turnEndedEvent() {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as const;
}

function compactionCompletedEvent() {
  return {
    type: 'compaction.completed',
    sessionId: 's1',
    agentId: 'main',
    result: {
      summary: 'summary',
      tokensBefore: 100,
      tokensAfter: 10,
      compactedCount: 1,
    },
  } as const;
}

function modelBlockedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
    change: { kind: 'lifecycle', status: 'blocked' },
  } as const;
}

function addedTranscriptText(host: ReturnType<typeof makeHost>['host']): string {
  const entry = host.appendTranscriptEntry.mock.calls.at(-1)?.[0] as
    | { goalData?: { kind?: string; change?: GoalChange } }
    | undefined;
  const change = entry?.goalData?.change;
  if (change === undefined) return '';
  const component = buildGoalMarker(change, false, change.actor);
  if (component === null) return '';
  return component
    .render(80)
    .join('\n')
    .replaceAll(/\[[0-9;]*m/g, '');
}

describe('SessionEventHandler goal queue promotion', () => {
  beforeEach(() => {
    readGoalQueueMock.mockClear();
    removeGoalQueueItemMock.mockClear();
    restoreGoalQueueItemMock.mockClear();
  });

  it('starts the next queued goal after the completion turn ends', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), mock());
    expect(session.createGoal).not.toHaveBeenCalled();
    handler.handleEvent(clearedEvent(), mock());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await waitForAssertion(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, {
      text: 'Ship queued goal',
    });
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('waits for queued user input to drain before promoting the next queued goal', async () => {
    const { host, session } = makeHost();
    host.state.queuedMessages = [{ text: 'queued user turn' }];
    host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    });
    host.shiftQueuedMessage.mockImplementation(() => host.state.queuedMessages.shift());
    host.streamingUI.finalizeTurn.mockImplementation((sendQueued: (item: unknown) => void) => {
      const next = host.shiftQueuedMessage();
      if (next !== undefined) {
        host.setAppState({ streamingPhase: 'idle' });
        setTimeout(() => {
          sendQueued(next);
        }, 0);
        return;
      }
      host.setAppState({ streamingPhase: 'idle' });
    });
    host.sendQueuedMessage.mockImplementation((_session: unknown, item: { text: string }) => {
      if (item.text === 'queued user turn') {
        host.setAppState({ streamingPhase: 'waiting' });
      }
    });
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host, session);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, { text: 'queued user turn' });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(host.sendQueuedMessage).toHaveBeenLastCalledWith(session, { text: 'Ship queued goal' });
  });

  it('defers queued-goal promotion while a queued message is mid-dispatch', async () => {
    const { host, session } = makeHost();
    host.state.appState.streamingPhase = 'idle';
    host.state.queuedMessages = [];
    // The queue looks empty and the phase is idle, but a shifted queued message
    // is still awaiting its deferred send. Promotion must not jump ahead of it.
    host.state.queuedMessageDispatchPending = true;
    const handler = new SessionEventHandler(host);

    handler.requestQueuedGoalPromotion();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();

    // Once the queued message has been dispatched, the flag clears and the
    // promotion proceeds on the next retry.
    host.state.queuedMessageDispatchPending = false;
    handler.retryQueuedGoalPromotion();
    await waitForAssertion(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
  });

  it('waits for a queued user input drained after compaction before promoting the next queued goal', async () => {
    const { host, session } = makeHost();
    host.state.appState.isCompacting = true;
    host.state.queuedMessages = [{ text: 'queued user turn' }];
    host.shiftQueuedMessage.mockImplementation(() => host.state.queuedMessages.shift());
    const handler = new SessionEventHandler(host);
    host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
      const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
      Object.assign(host.state.appState, patch);
      if (busyChanged) handler.retryQueuedGoalPromotion();
    });
    host.sendQueuedMessage.mockImplementation((_session: unknown, item: { text: string }) => {
      if (item.text === 'queued user turn') {
        host.setAppState({ streamingPhase: 'waiting' });
      }
    });
    const sendQueued = sendQueuedViaHost(host, session);

    handler.requestQueuedGoalPromotion();
    handler.handleEvent(compactionCompletedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, { text: 'queued user turn' });
    });
    expect(session.createGoal).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    const sendQueuedCalls = host.sendQueuedMessage.mock.calls as Array<
      [unknown, { text?: string }]
    >;
    const userMessageIndex = sendQueuedCalls.findIndex(
      ([, item]) => item.text === 'queued user turn',
    );
    expect(userMessageIndex).toBeGreaterThanOrEqual(0);
    expect(host.sendQueuedMessage).toHaveBeenLastCalledWith(session, { text: 'Ship queued goal' });
    const userMessageOrder = host.sendQueuedMessage.mock.invocationCallOrder[userMessageIndex]!;
    const goalCreateOrder = session.createGoal.mock.invocationCallOrder[0]!;
    expect(userMessageOrder).toBeLessThan(goalCreateOrder);
  });

  it('leaves the queued goal in place when the next goal cannot start', async () => {
    const { host, session } = makeHost({ createGoalRejects: true });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), mock());
    handler.handleEvent(clearedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), mock());

    await waitForAssertion(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(removeGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
    expect(session.createGoal).toHaveBeenCalledTimes(1);
  });

  it('retries the queued goal on a later idle event after startup fails', async () => {
    const { host, session } = makeHost();
    session.createGoal.mockRejectedValueOnce(new Error('create failed'));
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host, session);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(removeGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await waitForAssertion(() => {
      expect(session.createGoal).toHaveBeenCalledTimes(2);
    });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, { text: 'Ship queued goal' });
  });

  it('does not send the queued objective when removal fails after goal creation', async () => {
    removeGoalQueueItemMock.mockRejectedValueOnce(new Error('remove failed'));
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), mock());
    handler.handleEvent(clearedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), mock());

    await waitForAssertion(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('could not be removed'));
    });
    expect(session.createGoal).toHaveBeenCalledWith({
      objective: 'Ship queued goal',
      replace: false,
    });
    expect(session.cancelGoal).toHaveBeenCalledTimes(1);
    expect(restoreGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores the queued goal and cancels the started goal when the session changes before send', async () => {
    const { host, session } = makeHost();
    removeGoalQueueItemMock.mockImplementationOnce(async () => {
      host.session = undefined;
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), mock());
    handler.handleEvent(clearedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await waitForAssertion(() => {
      expect(restoreGoalQueueItem).toHaveBeenCalledWith(session, {
        id: 'q1',
        objective: 'Ship queued goal',
        createdAt: '',
        updatedAt: '',
      });
    });
    expect(session.cancelGoal).toHaveBeenCalledTimes(1);
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores and cancels when the host becomes busy before sending the promoted goal', async () => {
    const { host, session } = makeHost();
    removeGoalQueueItemMock.mockImplementationOnce(async () => {
      host.setAppState({ streamingPhase: 'waiting' });
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), mock());
    handler.handleEvent(clearedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await waitForAssertion(() => {
      expect(restoreGoalQueueItem).toHaveBeenCalledWith(session, {
        id: 'q1',
        objective: 'Ship queued goal',
        createdAt: '',
        updatedAt: '',
      });
    });
    expect(session.cancelGoal).toHaveBeenCalledTimes(1);
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('shows a notice when a blocked goal has queued goals', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);
    const event = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
      change: { kind: 'lifecycle', status: 'blocked', reason: 'waiting for access' },
    } as const;

    handler.handleEvent(event, mock());

    await waitForAssertion(() => {
      expect(host.showNotice).toHaveBeenCalledWith(
        'Goal blocked.',
        'The next queued goal will start only after this goal is complete.',
      );
    });
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('does not render a duplicate marker for a model-reported blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), mock());

    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('renders a blocked fallback when the model does not explain the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), mock());

    expect(addedTranscriptText(host)).toBe(`  ${STATUS_DOT} Goal blocked`);
  });

  it('does not render a blocked fallback after the model explains the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), mock());
    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      mock(),
    );
    handler.handleEvent(turnEndedEvent(), mock());

    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('does not render a blocked fallback after earlier assistant text in the same turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      mock(),
    );
    handler.handleEvent(modelBlockedEvent(), mock());
    handler.handleEvent(turnEndedEvent(), mock());

    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('does not promote on paused or cancelled updates', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);
    const paused = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Paused goal', 'paused'),
      change: { kind: 'lifecycle', status: 'paused' },
    } as const;

    handler.handleEvent(paused, mock());
    handler.handleEvent(clearedEvent(), mock());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });
});
