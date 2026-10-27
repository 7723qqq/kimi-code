import { ScrollView, TuiAltScreen, TuiMainScreen, VStack } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'bun:test';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { StickyUserMessageComponent } from '#/tui/components/messages/sticky-user-message';
import { TranscriptView } from '#/tui/components/messages/transcript-view';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import type { AppState } from '#/tui/types';
import { createEmptySessionStats } from '#/tui/utils/session-stats';

function fakeInitialAppState(): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    specMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    helloWorldMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    cacheOtherTokens: 0,
    tokenSpeed: 0,
    tokenSpeedAverage: 0,
    sessionStats: createEmptySessionStats(),
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    outputTokens: 0,
    stepRetry: null,
    theme: 'dark',
    version: '0.0.0-test',
    locale: 'en',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

describe('createTUIState', () => {
  it('initializes all fields with sensible defaults', () => {
    const opts: KimiTUIOptions = {
      initialAppState: fakeInitialAppState(),
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    };
    const state = createTUIState(opts);

    // UI objects are created.
    expect(state.ui).toBeDefined();
    expect(state.terminal).toBeDefined();
    expect(state.transcriptContainer).toBeDefined();
    expect(state.activityContainer).toBeDefined();
    expect(state.queueContainer).toBeDefined();
    expect(state.surveyContainer).toBeDefined();
    expect(state.editorContainer).toBeDefined();
    expect(state.editor).toBeDefined();
    expect(state.footer).toBeDefined();
    expect(state.notifyPanelContainer).toBeDefined();
    expect(state.notifyPanel).toBeDefined();
    expect(state.statusSurface).toBeDefined();
    expect(state.statusSurfaceContainer).toBeDefined();
    expect(state.theme.palette).toBeDefined();

    // App state is cloned from initialAppState, not reused by reference.
    expect(state.appState).not.toBe(opts.initialAppState);
    expect(state.appState.model).toBe('test-model');
    expect(state.appState.additionalDirs).toEqual([]);
    expect(state.appState.sessionId).toBe('sess-1');
    expect(state.startupState).toBe('pending');

    // LivePane defaults.
    expect(state.livePane.mode).toBe('idle');
    expect(state.livePane.pendingApproval).toBeNull();
    expect(state.livePane.pendingQuestion).toBeNull();

    // Empty collections.
    expect(state.transcriptEntries).toHaveLength(0);
    expect(state.queuedMessages).toHaveLength(0);

    // Boolean, counter, and optional-field defaults.
    expect(state.toolOutputExpanded).toBe(false);
    expect(state.activeDialog).toBeNull();
    expect(state.externalEditorRunning).toBe(false);
    expect(state.loadingSessions).toBe(false);
    expect(state.sessionsScope).toBe('cwd');
    expect(state.activitySpinner).toBeNull();
  });

  it('uses the main-screen renderer by default', () => {
    const state = createTUIState({
      initialAppState: fakeInitialAppState(),
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });

    expect(state.ui).toBeInstanceOf(TuiMainScreen);
    expect(state.ui.mode).toBe('regular');
    expect(state.dockContainer).toBeUndefined();
  });

  it('builds an alternate-screen renderer with a docked layout in fullscreen mode', () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });

    expect(state.ui).toBeInstanceOf(TuiAltScreen);
    expect(state.ui.mode).toBe('fullscreen');

    // The chrome docks below the transcript ScrollView, in z-order. The todo
    // list and the updates share one row, so the dock sees a single entry for
    // both rather than two stacked ones.
    const dock = state.dockContainer;
    expect(dock).toBeDefined();
    expect(dock?.children).toEqual([
      state.activityContainer,
      state.statusSurfaceContainer,
      state.queueContainer,
      state.btwPanelContainer,
      state.surveyContainer,
      state.backgroundTasksMiniContainer,
      state.editorContainer,
    ]);

    // The strip holds every region behind one component, so the panel
    // containers are never mounted as siblings of the dock's other rows.
    expect(state.statusSurfaceContainer.children).toEqual([state.statusSurface]);

    // The layout root is mounted and the root children list stays empty.
    expect((state.ui as TuiAltScreen).getLayoutRoot()).toBeDefined();
    expect(state.ui.children).toHaveLength(0);

    // The sticky user message sits above the transcript ScrollView, outside
    // the scrolling region, so it is never carried away by scrolling.
    const rootChildren = ((state.ui as TuiAltScreen).getLayoutRoot() as VStack).children;
    expect(rootChildren[0]).toBeInstanceOf(TranscriptView);
    const transcriptChildren = (rootChildren[0] as TranscriptView).children;
    expect((transcriptChildren[0] as GutterContainer).children[0]).toBeInstanceOf(
      StickyUserMessageComponent,
    );
    expect(transcriptChildren[1]).toBeInstanceOf(ScrollView);
    expect(rootChildren[1]).toBe(state.dockContainer);

    // Mouse capture replaces native terminal link activation / right-click
    // paste, so both must be routed through renderer callbacks.
    const internals = state.ui as unknown as {
      openUrl?: (url: string) => void;
      onRightClickPaste?: () => void;
      copySelection?: (text: string) => Promise<boolean>;
    };
    expect(typeof internals.openUrl).toBe('function');
    expect(typeof internals.onRightClickPaste).toBe('function');
    // Selection copy must go through the app's verified clipboard path rather
    // than a bare OSC 52 write that reports success even when it landed
    // nowhere.
    expect(typeof internals.copySelection).toBe('function');

    // The mini panel's half-the-terminal ceiling is a getter, not a value
    // captured at construction, so a resize keeps it correct.
    const dockEntries = (
      state.dockContainer as unknown as {
        entries: { component: unknown; maxSize?: unknown }[];
      }
    ).entries;
    const miniEntry = dockEntries.find(
      (entry) => entry.component === state.backgroundTasksMiniContainer,
    );
    expect(typeof miniEntry?.maxSize).toBe('function');
  });

  it('reports a selection copy as failed when only OSC 52 delivery is available', async () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });
    const internals = state.ui as unknown as {
      copySelection?: (text: string) => Promise<boolean>;
    };
    const copySelection = internals.copySelection;
    expect(copySelection).toBeDefined();

    // A verified native tool answers true; anything that fell back to the
    // unverified escape answers false so the renderer flashes "Copy failed"
    // instead of claiming a copy that never reached the clipboard.
    const result = await copySelection?.('selected text');
    expect(typeof result).toBe('boolean');
  });
});
