import { afterEach, describe, expect, it, jest } from 'bun:test';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { compactForModelSwitch, confirmThenPerformModelSwitch } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
  type ModelSwitchAction,
} from '#/utils/model-switch-confirm-config';

import { waitForAssertion } from '../../helpers/waitFor';

type TestEvent = { type: string; code?: string; agentId?: string };

function fakeSession() {
  const listeners = new Set<(event: TestEvent) => void>();
  const compact = jest.fn(async () => undefined);
  const session = {
    onEvent: (listener: (event: TestEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    compact,
  } as unknown as Session;
  return {
    session,
    compact,
    listenerCount: () => listeners.size,
    emit: (event: TestEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function fakeHost(session: Session) {
  return {
    session,
    showError: jest.fn(),
    showNotice: jest.fn(),
  } as unknown as SlashCommandHost;
}

afterEach(() => {
  jest.useRealTimers();
});

describe('compactForModelSwitch', () => {
  it('compacts and proceeds once the completed event lands', async () => {
    const { session, compact, emit, listenerCount } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed', agentId: 'main' });

    await expect(pending).resolves.toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
  });

  it('ignores a child agent compaction until the main agent finishes', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);
    let settled = false;
    const pending = compactForModelSwitch(host, session).then((value) => {
      settled = true;
      return value;
    });

    emit({ type: 'compaction.completed', agentId: 'child-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    emit({ type: 'compaction.completed', agentId: 'main' });
    await expect(pending).resolves.toBe(true);
  });

  it('aborts with a notice when the compaction is cancelled', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.cancelled', agentId: 'main' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Compaction cancelled — model unchanged.');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('aborts when the compaction fails', async () => {
    const { session, emit } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'error', code: 'compaction.failed', agentId: 'main' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — model unchanged.');
  });

  it('aborts when the compact request itself rejects', async () => {
    const { session, compact } = fakeSession();
    compact.mockRejectedValue(new Error('engine busy'));
    const host = fakeHost(session);

    await expect(compactForModelSwitch(host, session)).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith('Failed to compact: engine busy. Model unchanged.');
  });

  it('explains a compaction the running agent refuses instead of blaming the engine', async () => {
    const { session, compact } = fakeSession();
    const refusal = Object.assign(new Error('cannot compact'), { code: 'compaction.unable' });
    compact.mockRejectedValue(refusal);
    const host = fakeHost(session);

    await expect(compactForModelSwitch(host, session)).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith(
      "Couldn't compact while the agent is still running — model unchanged. Pause the goal or switch with Continue as-is.",
    );
    expect(host.showError).not.toHaveBeenCalledWith(
      'Failed to compact: cannot compact. Model unchanged.',
    );
  });

  it('aborts when the session changed while waiting', async () => {
    const { session, emit } = fakeSession();
    const { session: otherSession } = fakeSession();
    const host = fakeHost(otherSession);

    const pending = compactForModelSwitch(host, session);
    emit({ type: 'compaction.completed', agentId: 'main' });

    await expect(pending).resolves.toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith('Model switch aborted — session changed.');
  });

  it('aborts with an error when the compaction never settles', async () => {
    jest.useFakeTimers();
    const { session } = fakeSession();
    const host = fakeHost(session);

    const pending = compactForModelSwitch(host, session);
    await jest.advanceTimersByTime(10 * 60 * 1000);

    await expect(pending).resolves.toBe(false);
    expect(host.showError).toHaveBeenCalledWith(
      'Timed out waiting for compaction — model unchanged.',
    );
  });
});

type MountedDialog = {
  opts: { onSelect: (action: ModelSwitchAction) => void; onCancel: () => void };
};

function makeSwitchHost() {
  const turnContext: { turnId: string | undefined; step: number } = { turnId: undefined, step: 0 };
  const appState = {
    model: 'old-alias',
    thinkingEffort: 'off',
    streamingPhase: 'idle',
    isCompacting: false,
    sessionId: 'ses-old',
    availableModels: {
      'old-alias': { model: 'upstream-old', displayName: 'Old' },
      'new-alias': { model: 'upstream-new', displayName: 'New' },
    },
  };
  let currentModel = 'old-alias';
  let currentEffort = 'off';
  const session = {
    setModel: jest.fn(async (alias: string) => {
      currentModel = alias;
    }),
    setThinking: jest.fn(async (effort: string) => {
      currentEffort = effort;
    }),
    getStatus: jest.fn(async () => ({ model: currentModel, thinkingEffort: currentEffort })),
    onEvent: () => () => {},
    compact: jest.fn(async () => undefined),
  } as unknown as Session;
  const mountEditorReplacement = jest.fn();
  const restoreEditor = jest.fn();
  const createNewSession = jest.fn(async () => {});
  const activateModelAfterLogin = jest.fn(async () => true);
  const enqueueModelSwitch = jest.fn();
  const host = {
    state: {
      appState,
      transcriptEntries: [{ kind: 'user', bullet: 'hi' }],
      activeDialog: null,
      queuedMessageDispatchPending: false,
    },
    session,
    streamingUI: {
      hasActiveTurn: jest.fn(() => turnContext.turnId !== undefined),
      getTurnContext: jest.fn(() => turnContext),
    },
    completedCompactionSerial: 0,
    resetLivePane: jest.fn(),
    drainQueueIfIdle: jest.fn(),
    enqueueModelSwitch,
    authFlow: { activateModelAfterLogin },
    createNewSession,
    waitForLazyCreation: jest.fn(async () => {}),
    setAppState: jest.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    mountEditorReplacement,
    restoreEditor,
    showError: jest.fn(),
    showNotice: jest.fn(),
    showStatus: jest.fn(),
    track: jest.fn(),
  } as unknown as SlashCommandHost;
  return {
    host,
    session,
    appState,
    turnContext,
    mountEditorReplacement,
    restoreEditor,
    createNewSession,
    activateModelAfterLogin,
    enqueueModelSwitch,
  };
}

function mountedDialog(mountEditorReplacement: ReturnType<typeof jest.fn>): MountedDialog {
  return mountEditorReplacement.mock.calls[0]?.[0] as unknown as MountedDialog;
}

async function enableRule(): Promise<void> {
  await refreshModelSwitchConfirmConfig({
    fetchImpl: jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'model_switch_confirm',
            config: { enable: true, rules: [{ from: 'upstream-old', to: 'upstream-new' }] },
          }),
        ),
    ) as unknown as typeof fetch,
  });
}

describe('confirmThenPerformModelSwitch new-session action', () => {
  afterEach(() => {
    resetModelSwitchConfirmConfigCache();
  });

  it('does not switch when the new session fails to be created', async () => {
    const { host, session, mountEditorReplacement, activateModelAfterLogin } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('new');
    await waitForAssertion(() => expect(host.restoreEditor).toHaveBeenCalled());

    expect(session.setModel).not.toHaveBeenCalled();
    expect(activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('switches only after the new session is ready, keeping the dialog locked meanwhile', async () => {
    const { host, session, appState, mountEditorReplacement, restoreEditor, createNewSession } =
      makeSwitchHost();
    await enableRule();
    let releaseCreation!: () => void;
    createNewSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCreation = resolve;
        }),
    );
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    dialog.opts.onSelect('new');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(restoreEditor).not.toHaveBeenCalled();

    releaseCreation();
    await waitForAssertion(() => expect(restoreEditor).toHaveBeenCalled());
    expect(session.setModel).not.toHaveBeenCalled();
    expect(appState.sessionId).toBe('ses-old');
  });

  it('switches the model once the new session exists', async () => {
    const { host, session, appState, mountEditorReplacement, createNewSession } = makeSwitchHost();
    await enableRule();
    createNewSession.mockImplementation(async () => {
      appState.sessionId = 'ses-new';
    });
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('new');
    await waitForAssertion(() => expect(host.restoreEditor).toHaveBeenCalled());

    expect(session.setModel).toHaveBeenCalledWith('new-alias');
  });

  it('queues the compact-then-switch action while the agent is busy', async () => {
    const { host, session, appState, mountEditorReplacement, enqueueModelSwitch } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('compact');
    await waitForAssertion(() =>
      expect(enqueueModelSwitch).toHaveBeenCalledWith('new-alias', 'high', 'session'),
    );
    expect(session.compact).not.toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('still switches immediately on continue while busy', async () => {
    const { host, session, appState, mountEditorReplacement } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onSelect('continue');
    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
  });

  it('dismisses on Escape before any action is chosen', async () => {
    const { host, session, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    mountedDialog(mountEditorReplacement).opts.onCancel();

    expect(restoreEditor).toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('ignores Escape once an action has been chosen', async () => {
    const { host, mountEditorReplacement, restoreEditor, createNewSession } = makeSwitchHost();
    await enableRule();
    let releaseCreation!: () => void;
    createNewSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCreation = resolve;
        }),
    );
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    dialog.opts.onCancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoreEditor).not.toHaveBeenCalled();

    releaseCreation();
    await waitForAssertion(() => expect(restoreEditor).toHaveBeenCalled());
  });

  it('does not dismiss a panel that displaced the dialog when creation settles', async () => {
    const { host, mountEditorReplacement, restoreEditor } = makeSwitchHost();
    await enableRule();
    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');
    const dialog = mountedDialog(mountEditorReplacement);

    dialog.opts.onSelect('new');
    (host.state as unknown as { activeDialog: string | null }).activeDialog = null;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restoreEditor).not.toHaveBeenCalled();
  });
});

describe('model switch while the agent is busy', () => {
  afterEach(() => {
    resetModelSwitchConfirmConfigCache();
  });

  it('switches directly once the running turn has sent its first request and says so', async () => {
    const { host, session, appState, turnContext, mountEditorReplacement } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    turnContext.turnId = '4';
    turnContext.step = 1;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Switched to New with thinking high for this session only. Takes effect from the next turn.',
      'success',
    );
  });

  it('does not promise a next-turn switch after submit and before the first request', async () => {
    const { host, session, appState, turnContext } = makeSwitchHost();
    appState.streamingPhase = 'waiting';
    turnContext.turnId = '7';
    turnContext.step = 0;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(host.showStatus).toHaveBeenCalledWith(
      'Switched to New with thinking high for this session only.',
      'success',
    );
  });

  it('promises a next-turn switch while a shell command is running', async () => {
    const { host, session, appState } = makeSwitchHost();
    appState.streamingPhase = 'shell';

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(host.showStatus).toHaveBeenCalledWith(
      'Switched to New with thinking high for this session only. Takes effect from the next turn.',
      'success',
    );
  });

  it('promises a next-turn switch while a compaction is running', async () => {
    const { host, session, appState } = makeSwitchHost();
    appState.isCompacting = true;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(host.showStatus).toHaveBeenCalledWith(
      'Switched to New with thinking high for this session only. Takes effect from the next turn.',
      'success',
    );
  });

  it('keeps an idle switch notice unchanged when replay left a started step', async () => {
    const { host, session, turnContext } = makeSwitchHost();
    turnContext.turnId = 'replay:2';
    turnContext.step = 2;

    confirmThenPerformModelSwitch(host, 'new-alias', 'high', 'session');

    await waitForAssertion(() => expect(session.setModel).toHaveBeenCalledWith('new-alias'));
    expect(host.showStatus).toHaveBeenCalledWith(
      'Switched to New with thinking high for this session only.',
      'success',
    );
  });
});
