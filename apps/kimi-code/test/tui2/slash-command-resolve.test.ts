/**
 * TUI2 slash-command resolution + dispatch combo tests.
 *
 * Pins the ported v1 behaviors: `/tower` availability (experimental flag +
 * requiresEngineV2 gate), the `secondary_model` flag id, inline/bundled
 * skill submission claiming in `dispatchInput`, rejected-command input
 * restoration, and `canRestoreSubmittedInput`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '@/tui2/commands/dispatch';
import { canRestoreSubmittedInput, resolveSlashCommandInput } from '@/tui2/commands/resolve';
import { setExperimentalFeatures } from '@/tui2/commands/experimental-flags';

function resolve(
  input: string,
  overrides: Partial<Parameters<typeof resolveSlashCommandInput>[0]> = {},
) {
  return resolveSlashCommandInput({
    input,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    isStreaming: false,
    isCompacting: false,
    ...overrides,
  });
}

afterEach(() => {
  setExperimentalFeatures([]);
});

describe('tui2 /tower resolution', () => {
  it('resolves /tower to the builtin command when the tower flag is enabled', () => {
    setExperimentalFeatures([{ id: 'tower', enabled: true }]);

    expect(resolve('/tower Ship feature X', { engineV2: true })).toMatchObject({
      kind: 'builtin',
      name: 'tower',
      args: 'Ship feature X',
    });
  });

  it('does not resolve /tower when the tower flag is disabled', () => {
    setExperimentalFeatures([{ id: 'tower', enabled: false }]);

    expect(resolve('/tower Ship feature X', { engineV2: true })).toEqual({
      kind: 'message',
      input: '/tower Ship feature X',
    });
  });

  it('does not resolve /tower on the legacy engine even when flagged on', () => {
    setExperimentalFeatures([{ id: 'tower', enabled: true }]);

    expect(resolve('/tower on', { engineV2: false })).toEqual({
      kind: 'message',
      input: '/tower on',
    });
  });

  it('keeps pure reads always-available but gates objective args while streaming', () => {
    setExperimentalFeatures([{ id: 'tower', enabled: true }]);

    expect(resolve('/tower status', { isStreaming: true, engineV2: true })).toMatchObject({
      kind: 'builtin',
      name: 'tower',
    });
    expect(resolve('/tower Ship it', { isStreaming: true, engineV2: true })).toEqual({
      kind: 'blocked',
      commandName: 'tower',
      reason: 'streaming',
    });
  });
});

describe('tui2 secondary-model flag id', () => {
  it('gates /secondary-model behind the engine id `secondary_model`', () => {
    // Gated off while the flag is absent from the snapshot.
    expect(resolve('/secondary-model')).toEqual({ kind: 'message', input: '/secondary-model' });

    // The old hyphenated id must have no effect; the engine id does.
    setExperimentalFeatures([{ id: 'secondary-model', enabled: false }]);
    expect(resolve('/secondary-model')).toEqual({ kind: 'message', input: '/secondary-model' });
    setExperimentalFeatures([{ id: 'secondary_model', enabled: false }]);
    expect(resolve('/secondary-model')).toEqual({ kind: 'message', input: '/secondary-model' });

    setExperimentalFeatures([{ id: 'secondary_model', enabled: true }]);
    expect(resolve('/secondary-model')).toMatchObject({ kind: 'builtin', name: 'secondary-model' });
  });
});

interface DispatchHostCalls {
  sent: string[];
  activated: Array<{ skillName: string; args: string }>;
  errors: string[];
  restored: string[];
}

function makeDispatchHost(
  calls: DispatchHostCalls,
  overrides: Record<string, unknown> = {},
): SlashCommandHost {
  const base = {
    state: {
      appState: { streamingPhase: 'idle', isCompacting: false, model: 'test-model' },
      transcriptEntries: [],
      activeDialog: null,
      ui: { requestRender: () => {} },
    },
    store: undefined,
    session: { id: 's1' },
    harness: {},
    engineV2: true,
    cancelInFlight: undefined,
    deferUserMessages: false,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    track: vi.fn(),
    showError: (msg: string) => calls.errors.push(msg),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    restoreInputText: (text: string) => calls.restored.push(text),
    resetLivePane: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    refreshPluginCommands: vi.fn(async () => {}),
    refreshSkillCommands: vi.fn(async () => {}),
    hydrateLazyConfigDefaults: vi.fn(async () => {}),
    requireSession: () => ({}) as never,
    ensureSession: vi.fn(async () => ({}) as never),
    waitForLazyCreation: vi.fn(async () => {}),
    switchToSession: vi.fn(async () => {}),
    reloadCurrentSessionView: vi.fn(async () => {}),
    beginSessionRequest: vi.fn(),
    failSessionRequest: vi.fn(),
    sendQueuedMessage: vi.fn(),
    stop: vi.fn(async () => {}),
    setExitOpenUrl: vi.fn(),
    setExitForegroundTask: vi.fn(),
    showHelpPanel: vi.fn(),
    createNewSession: vi.fn(async () => {}),
    showSessionPicker: vi.fn(async () => {}),
    sendNormalUserInput: (text: string) => calls.sent.push(text),
    sendSkillActivation: (_s: unknown, skillName: string, args: string) =>
      calls.activated.push({ skillName, args }),
    activatePluginCommand: vi.fn(),
    streamingUI: {},
    btwPanelController: { sendUserInput: () => false },
    tasksBrowserController: { show: vi.fn() },
    authFlow: {},
    setAppState: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as SlashCommandHost;
}

describe('tui2 dispatchInlineSkillCombo', () => {
  it('claims a leading bundle of two known skills as one prompt', () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls);
    host.skillCommandMap.set('skill:review', 'review');
    host.skillCommandMap.set('skill:fix', 'fix');

    dispatchInput(host, '/review /fix clean this up');

    expect(calls.sent).toEqual(['/review /fix clean this up']);
    expect(calls.activated).toEqual([]);
  });

  it('does not claim a single leading skill — the standalone slash path keeps its args', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls);
    host.skillCommandMap.set('skill:review', 'review');

    dispatchInput(host, '/review src/app.ts');
    await Promise.resolve();

    expect(calls.sent).toEqual([]);
    expect(calls.activated).toEqual([{ skillName: 'review', args: 'src/app.ts' }]);
  });

  it('claims an unrecognized leading slash that mentions an inline skill', () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls);
    host.skillCommandMap.set('skill:review', 'review');

    dispatchInput(host, '/unknowncmd please /review this');

    expect(calls.sent).toEqual(['/unknowncmd please /review this']);
    expect(calls.activated).toEqual([]);
  });

  it('lets a recognized builtin keep its own path despite mentioned skills', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls, { store: undefined });
    host.skillCommandMap.set('skill:helpish', 'helpish');

    dispatchInput(host, '/version /helpish');
    await Promise.resolve();

    expect(calls.sent).toEqual([]);
    expect(calls.activated).toEqual([]);
  });
});

describe('tui2 rejected-command input restore', () => {
  it('returns the input line to the editor when a command is blocked while busy', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls, {
      state: {
        appState: { streamingPhase: 'waiting', isCompacting: false, model: 'test-model' },
        transcriptEntries: [],
        activeDialog: null,
        ui: { requestRender: () => {} },
      },
    });

    dispatchInput(host, '/undo');
    for (let i = 0; i < 20 && calls.restored.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls.restored).toEqual(['/undo']);
    expect(calls.errors.length).toBe(1);
  });
  it('restores after lazy creation fails only when the editor was not reused', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const failingStore = {
      state: { editorDraft: '', activeDialog: null },
      setState: vi.fn(),
      patch: vi.fn(),
    };
    const host = makeDispatchHost(calls, {
      session: undefined,
      store: failingStore,
      ensureSession: vi.fn(async () => undefined),
      state: {
        appState: { streamingPhase: 'idle', isCompacting: false, model: 'test-model' },
        transcriptEntries: [],
        activeDialog: null,
        ui: { requestRender: () => {} },
      },
    });

    dispatchInput(host, '/goal do the thing');
    for (let i = 0; i < 20 && calls.restored.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls.restored).toEqual(['/goal do the thing']);
  });

  it('canRestoreSubmittedInput guards on draft text and open dialogs', () => {
    const store = (editorDraft: string, activeDialog: string | null) =>
      ({
        state: { editorDraft, activeDialog },
        setState: vi.fn(),
        patch: vi.fn(),
      }) as never;

    expect(canRestoreSubmittedInput(store('', null))).toBe(true);
    expect(canRestoreSubmittedInput(store('newer draft', null))).toBe(false);
    expect(canRestoreSubmittedInput(store('', 'model-selector'))).toBe(false);
    expect(canRestoreSubmittedInput(undefined)).toBe(true);
  });
});

describe('tui2 skill queueing while busy', () => {
  it('resolves skill commands even when the session is busy (v1 behavior)', () => {
    const intent = resolveSlashCommandInput({
      input: '/review src/app.ts',
      skillCommandMap: new Map([['skill:review', 'review']]),
      pluginCommandMap: new Map<string, string>(),
      isStreaming: true,
      isCompacting: false,
    });
    expect(intent).toMatchObject({ kind: 'skill', skillName: 'review', args: 'src/app.ts' });

    const compacting = resolveSlashCommandInput({
      input: '/review',
      skillCommandMap: new Map([['skill:review', 'review']]),
      pluginCommandMap: new Map<string, string>(),
      isStreaming: false,
      isCompacting: true,
    });
    expect(compacting).toMatchObject({ kind: 'skill' });
  });

  function makeQueueStore(queued: unknown[] = []) {
    return {
      state: { queuedMessages: queued, editorDraft: '', activeDialog: null },
      setState: vi.fn((_key: string, value: unknown[]) => {
        queued.splice(0, queued.length, ...value);
      }),
      patch: vi.fn(),
    };
  }

  it('queues a skill command while streaming instead of rejecting it', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const queued: unknown[] = [];
    const host = makeDispatchHost(calls, {
      store: makeQueueStore(queued),
      state: {
        appState: { streamingPhase: 'composing', isCompacting: false, model: 'test-model' },
        transcriptEntries: [],
        activeDialog: null,
        ui: { requestRender: () => {} },
      },
    });
    host.skillCommandMap.set('skill:review', 'review');

    dispatchInput(host, '/review src/app.ts');
    await Promise.resolve();

    expect(calls.activated).toEqual([]);
    expect(calls.errors).toEqual([]);
    expect(calls.restored).toEqual([]);
    expect(queued).toEqual([
      { text: '/review src/app.ts', skillName: 'review', skillArgs: 'src/app.ts' },
    ]);
    expect((host.track as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([event]) => event === 'input_queue')).toBe(true);
  });

  it('queues behind a running compaction too', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const queued: unknown[] = [];
    const host = makeDispatchHost(calls, {
      store: makeQueueStore(queued),
      state: {
        appState: { streamingPhase: 'idle', isCompacting: true, model: 'test-model' },
        transcriptEntries: [],
        activeDialog: null,
        ui: { requestRender: () => {} },
      },
    });
    host.skillCommandMap.set('skill:fix', 'fix');

    dispatchInput(host, '/fix');
    await Promise.resolve();

    expect(queued).toEqual([
      { text: '/fix', skillName: 'fix', skillArgs: '' },
    ]);
  });

  it('still activates immediately when idle', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls, { store: makeQueueStore() });
    host.skillCommandMap.set('skill:review', 'review');

    dispatchInput(host, '/review src/app.ts');
    await Promise.resolve();

    expect(calls.activated).toEqual([{ skillName: 'review', args: 'src/app.ts' }]);
  });

  it('falls back to the busy rejection when the host has no response store', async () => {
    const calls: DispatchHostCalls = { sent: [], activated: [], errors: [], restored: [] };
    const host = makeDispatchHost(calls, {
      state: {
        appState: { streamingPhase: 'waiting', isCompacting: false, model: 'test-model' },
        transcriptEntries: [],
        activeDialog: null,
        ui: { requestRender: () => {} },
      },
    });
    host.skillCommandMap.set('skill:review', 'review');

    dispatchInput(host, '/review src/app.ts');
    await Promise.resolve();

    expect(calls.activated).toEqual([]);
    expect(calls.errors.length).toBe(1);
    expect(calls.restored).toEqual(['/review src/app.ts']);
  });
});
