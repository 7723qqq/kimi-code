import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Mock as BunMock } from 'bun:test';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';
import { setEnv, restoreEnvs } from '#test/helpers/stubs';
import { waitForAssertion } from '#test/helpers/waitFor';

import { DOUBLE_ESC_WINDOW_MS, getCtrlCHint } from '#/tui/constant/kimi-tui';
import {
  EditorKeyboardController,
  nextReviewMode,
  reviewCycleState,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import type { QueuedMessage } from '#/tui/types';

type Mock<T extends (...args: any[]) => any = (...args: any[]) => any> = BunMock<T>;

/** Injected timer source: the double-Esc / exit-confirm windows never touch real time. */
let clock: FakeClock;

beforeEach(() => {
  clock = createFakeClock(0);
});

interface Harness {
  readonly host: EditorKeyboardHost;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  readonly controller: EditorKeyboardController;
  readonly openUndoSelector: Mock<(...args: any[]) => any>;
  readonly cancelRunningShellCommand: Mock<(...args: any[]) => any>;
  readonly cancelCompaction: Mock<(...args: any[]) => any>;
  readonly btwCancelRunning: Mock<(...args: any[]) => any>;
  readonly btwCloseOrCancel: Mock<(...args: any[]) => any>;
  readonly footerHint: Mock<(...args: any[]) => any>;
  readonly promptOptimizer: { readonly optimize: Mock<(...args: any[]) => any> };
  readonly stop: Mock<(...args: any[]) => any>;
  readonly survey: {
    readonly handlePreInput: Mock<(data: string) => boolean>;
    readonly handleSubmit: Mock<(text: string) => boolean>;
    readonly handleEditorChange: Mock<(text: string) => void>;
    readonly notifyDisplaced: Mock<() => void>;
  };
}

function createHarness(options: { streamingPhase?: string; isCompacting?: boolean } = {}): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: mock() as unknown as (...args: never[]) => unknown,
    setInputMode: mock() as unknown as (...args: never[]) => unknown,
    getText: mock(() => '') as unknown as (...args: never[]) => unknown,
    setText: mock() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = mock();
  const cancelRunningShellCommand = mock();
  const cancelCompaction = mock(async () => {});
  const btwCancelRunning = mock(() => false);
  const btwCloseOrCancel = mock(() => false);
  const footerHint = mock();
  const stop = mock();
  const survey = {
    handlePreInput: mock<(data: string) => boolean>(() => false),
    handleSubmit: mock<(text: string) => boolean>(() => false),
    handleEditorChange: mock<(text: string) => void>(() => {}),
    notifyDisplaced: mock<() => void>(() => {}),
  };
  const session = { cancel: mock(async () => {}), cancelCompaction };
  const promptOptimizer = { optimize: mock(async () => {}) };

  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: {
        streamingPhase: options.streamingPhase ?? 'idle',
        isCompacting: options.isCompacting ?? false,
        editorCommand: null,
      },
      footer: { setTransientHint: footerHint },
      ui: { requestRender: mock() },
    },
    session,
    btwPanelController: { cancelRunning: btwCancelRunning, closeOrCancel: btwCloseOrCancel },
    surveyController: survey,
    promptOptimizer,
    openUndoSelector,
    cancelRunningShellCommand,
    updateEditorBorderHighlight: mock(),
    updateGoalLengthWarning: mock(),
    handleUserInput: mock(),
    track: mock(),
    openExternalEditor: mock(),
    showError: mock(),
    stop,
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
    clock,
  );
  controller.install();

  return {
    host,
    editor,
    controller,
    openUndoSelector,
    cancelRunningShellCommand,
    cancelCompaction,
    btwCancelRunning,
    btwCloseOrCancel,
    footerHint,
    promptOptimizer,
    stop,
    survey,
  };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressCtrlC(editor: Harness['editor']): void {
  const handler = editor['onCtrlC'];
  if (handler === undefined) throw new Error('onCtrlC handler not installed');
  (handler as () => void)();
}

function pressCtrlD(editor: Harness['editor']): void {
  const handler = editor['onCtrlD'];
  if (handler === undefined) throw new Error('onCtrlD handler not installed');
  (handler as () => void)();
}

function pressNonEscape(editor: Harness['editor']): void {
  const handler = editor['onNonEscapeInput'];
  if (handler === undefined) throw new Error('onNonEscapeInput handler not installed');
  (handler as () => void)();
}

describe('EditorKeyboardController double-Esc undo', () => {

  it('opens the undo selector when Esc is pressed twice within the window while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a single Esc while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when the second Esc arrives after the window expires', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    clock.advance(DOUBLE_ESC_WINDOW_MS + 1);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when another key is pressed between the two Esc presses', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    pressNonEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger undo while streaming; Esc cancels the stream instead', () => {
    const { editor, host, openUndoSelector, cancelRunningShellCommand } = createHarness({
      streamingPhase: 'waiting',
    });

    pressEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
    expect(cancelRunningShellCommand).toHaveBeenCalled();
    const session = host.session as unknown as { cancel: Mock<(...args: any[]) => any> };
    expect(session.cancel).toHaveBeenCalled();
  });
});

describe('EditorKeyboardController btw panel priority', () => {
  it('Esc closes the btw panel first while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledTimes(1);
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Esc cancels compaction on the next press once the btw panel is gone', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValueOnce(true);

    pressEscape(editor);
    expect(cancelCompaction).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(cancelCompaction).toHaveBeenCalledTimes(1);
  });

  it('Esc cancels compaction directly when no btw panel is open', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledTimes(1);
    expect(cancelCompaction).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C cancels a running btw question first while compacting', () => {
    const { editor, btwCancelRunning, cancelCompaction } = createHarness({ isCompacting: true });
    btwCancelRunning.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledTimes(1);
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C closes an idle btw panel while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledTimes(1);
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C cancels compaction when no btw panel is open', () => {
    const { editor, btwCancelRunning, btwCloseOrCancel, cancelCompaction } = createHarness({
      isCompacting: true,
    });

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledTimes(1);
    expect(btwCloseOrCancel).toHaveBeenCalledTimes(1);
    expect(cancelCompaction).toHaveBeenCalledTimes(1);
  });
});

describe('EditorKeyboardController disposal', () => {
  it('consumes every key after dispose so shutdown feedback is not clobbered', () => {
    const { editor, controller, footerHint, stop } = createHarness();

    pressCtrlC(editor);
    expect(footerHint).toHaveBeenCalledWith(getCtrlCHint());

    controller.dispose();
    footerHint.mockClear();

    const onPreInput = editor['onPreInput'];
    if (onPreInput === undefined) throw new Error('onPreInput handler not installed');
    expect((onPreInput as (data: string) => boolean)('\u0003')).toBe(true);
    expect((onPreInput as (data: string) => boolean)('\u001B')).toBe(true);
    expect((onPreInput as (data: string) => boolean)('a')).toBe(true);

    expect(stop).not.toHaveBeenCalled();
    expect(footerHint).not.toHaveBeenCalled();
  });
});

describe('EditorKeyboardController shell history recall', () => {
  type Recall = (entry: string, direction: 1 | -1) => string | undefined;

  it('installs a filter that allows shell entries only in bash mode', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    expect(setHistoryFilter).toHaveBeenCalledTimes(1);
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(true);

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(false);
  });

  it('locks the filter to the browse-entry mode once browsing starts', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    // Enter browse from prompt mode, then simulate landing on a shell entry
    // (which flips inputMode to bash). The filter should stay locked to prompt
    // and keep allowing plain entries.
    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    save();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    expect(filter('hello')).toBe(true);
    expect(filter('!cmd')).toBe(true);
  });

  it('strips the leading ! and switches to bash mode when recalling a shell entry', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('!cmd', -1);

    expect(result).toBe('cmd');
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('bash');
  });

  it('keeps plain entries as-is and switches to prompt mode', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('hello', -1);

    expect(result).toBeUndefined();
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });

  it('saves the current input mode as the history draft host state', () => {
    const { editor } = createHarness();
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(save()).toBe('prompt');

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(save()).toBe('bash');
  });

  it('restores the input mode from the saved draft host state', () => {
    const { editor } = createHarness();
    const restore = editor['onHistoryDraftRestore'] as unknown as (state: unknown) => void;

    restore('prompt');

    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });
});

describe('EditorKeyboardController Shift-Tab plan/spec cycle', () => {
  function createShiftTabHarness(
    options: { sessionless?: boolean; appState?: Record<string, unknown> } = {},
  ) {
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: mock() as unknown as (...args: never[]) => unknown,
    };
    const handlePlanToggle = mock();
    const handleExclusiveModeLeave = mock();
    const handleExclusiveModeSwitch = mock();
    const track = mock();
    const showError = mock();
    const ensureSession = mock(async (): Promise<{ id: string } | undefined> => ({ id: 'ses-lazy' }));
    const host = {
      state: {
        editor,
        activeDialog: null,
        appState: {
          streamingPhase: 'idle',
          isCompacting: false,
          planMode: false,
          specMode: false,
          swarmMode: false,
          towerMode: false,
          ...options.appState,
        },
        footer: { setTransientHint: mock() },
        ui: { requestRender: mock() },
      },
      session: options.sessionless ? undefined : { cancel: mock(async () => {}) },
      ensureSession,
      handlePlanToggle,
      handleExclusiveModeLeave,
      handleExclusiveModeSwitch,
      track,
      showError,
      btwPanelController: { cancelRunning: mock(), closeOrCancel: mock() },
    } as unknown as EditorKeyboardHost;

    new EditorKeyboardController(host, undefined as unknown as ImageAttachmentStore, clock).install();
    const onShiftTab = editor['onShiftTab'] as unknown as () => void;
    return {
      onShiftTab,
      handlePlanToggle,
      handleExclusiveModeLeave,
      handleExclusiveModeSwitch,
      track,
      showError,
      ensureSession,
    };
  }

  it('toggles plan mode directly with an active session', () => {
    const { onShiftTab, handlePlanToggle, ensureSession } = createShiftTabHarness();

    onShiftTab();

    expect(ensureSession).not.toHaveBeenCalled();
    expect(handlePlanToggle).toHaveBeenCalledWith(true);
  });

  it('lazy-creates the session before toggling on v2 when session-less', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle, track } = createShiftTabHarness({
      sessionless: true,
    });

    onShiftTab();
    expect(handlePlanToggle).not.toHaveBeenCalled();

    await waitForAssertion(() => {
      expect(handlePlanToggle).toHaveBeenCalledWith(true);
    });
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('shortcut_plan_toggle', { enabled: true });
  });

  it('does not toggle when the lazy creation fails on v2', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle } = createShiftTabHarness({
      sessionless: true,
    });
    ensureSession.mockResolvedValue(undefined);

    onShiftTab();
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('enters plan from no mode', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave } = createShiftTabHarness();

    onShiftTab();

    expect(handlePlanToggle).toHaveBeenCalledWith(true);
    expect(handleExclusiveModeLeave).not.toHaveBeenCalled();
  });

  it('enters spec from plan', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeSwitch } = createShiftTabHarness({
      appState: { planMode: true },
    });

    onShiftTab();

    // One press reaches spec. The old rule left plan here and needed a second
    // press to do anything else, which read as "the shortcut undid itself".
    expect(handleExclusiveModeSwitch).toHaveBeenCalledWith('spec');
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('returns to no mode from spec', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave, handleExclusiveModeSwitch } =
      createShiftTabHarness({ appState: { specMode: true } });

    onShiftTab();

    expect(handleExclusiveModeLeave).toHaveBeenCalledWith('spec');
    expect(handleExclusiveModeSwitch).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('never leaves swarm mode', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave, handleExclusiveModeSwitch, track } =
      createShiftTabHarness({ appState: { swarmMode: true } });

    onShiftTab();

    // Swarm is not on the plan/spec cycle: the shortcut must neither exit it nor
    // enter anything from it. `/swarm off` owns leaving.
    expect(handleExclusiveModeLeave).not.toHaveBeenCalled();
    expect(handleExclusiveModeSwitch).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('never leaves tower mode', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave, handleExclusiveModeSwitch, track } =
      createShiftTabHarness({ appState: { towerMode: true } });

    onShiftTab();

    expect(handleExclusiveModeLeave).not.toHaveBeenCalled();
    expect(handleExclusiveModeSwitch).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('does not switch plan or spec while swarm is active', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave, handleExclusiveModeSwitch } =
      createShiftTabHarness({ appState: { swarmMode: true, specMode: true } });

    onShiftTab();

    // A press while swarm runs must not be read as "leave spec".
    expect(handleExclusiveModeLeave).not.toHaveBeenCalled();
    expect(handleExclusiveModeSwitch).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('does not switch plan or spec while tower is active', () => {
    const { onShiftTab, handlePlanToggle, handleExclusiveModeLeave, handleExclusiveModeSwitch } =
      createShiftTabHarness({ appState: { towerMode: true, planMode: true } });

    onShiftTab();

    expect(handleExclusiveModeLeave).not.toHaveBeenCalled();
    expect(handleExclusiveModeSwitch).not.toHaveBeenCalled();
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('resumes the cycle once swarm is left', () => {
    const { onShiftTab, handlePlanToggle } = createShiftTabHarness({
      appState: { swarmMode: false, planMode: false, specMode: false },
    });

    onShiftTab();

    expect(handlePlanToggle).toHaveBeenCalledWith(true);
  });
});

describe('Shift-Tab cycle derivation', () => {
  function state(overrides: Partial<Record<string, boolean>> = {}) {
    return {
      planMode: false,
      specMode: false,
      swarmMode: false,
      helloWorldMode: false,
      towerMode: false,
      ...overrides,
    };
  }

  it('cycles none → plan → spec → none', () => {
    expect(nextReviewMode(reviewCycleState(state())!)).toBe('plan');
    expect(nextReviewMode(reviewCycleState(state({ planMode: true }))!)).toBe('spec');
    expect(nextReviewMode(reviewCycleState(state({ specMode: true }))!)).toBeNull();
  });

  it('does not apply while swarm, hello-world or tower is active', () => {
    expect(reviewCycleState(state({ swarmMode: true }))).toBeNull();
    expect(reviewCycleState(state({ helloWorldMode: true }))).toBeNull();
    expect(reviewCycleState(state({ towerMode: true }))).toBeNull();
    // Even with plan or spec also set, swarm/hello-world/tower keep the cycle out of play.
    expect(reviewCycleState(state({ swarmMode: true, specMode: true }))).toBeNull();
    expect(reviewCycleState(state({ helloWorldMode: true, specMode: true }))).toBeNull();
    expect(reviewCycleState(state({ towerMode: true, planMode: true }))).toBeNull();
  });

  it('exposes only the plan and spec flags to the cycle', () => {
    const cycle = reviewCycleState(state({ planMode: true, specMode: false }));
    expect(cycle).toEqual({ planMode: true, specMode: false });
  });
});

describe('EditorKeyboardController Ctrl-S steering', () => {
  function createCtrlSHarness(options: {
    editorText: string;
    queued: QueuedMessage[];
    skillCommandMap?: Map<string, string>;
    pluginCommandMap?: Map<string, string>;
    steering?: boolean;
  }) {
    const steerQueuedMessagesIntoRunningTurn = mock();
    const updateQueueDisplay = mock();
    const setText = mock();
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: mock() as unknown as (...args: never[]) => unknown,
      setInputMode: mock() as unknown as (...args: never[]) => unknown,
      getText: mock(() => options.editorText) as unknown as (...args: never[]) => unknown,
      setText: setText as unknown as (...args: never[]) => unknown,
      inputMode: 'prompt' as unknown as (...args: never[]) => unknown,
    };
    const host = {
      state: {
        editor,
        activeDialog: null,
        queuedMessages: options.queued,
        appState: { streamingPhase: 'waiting', isCompacting: false, model: 'k2' },
        footer: { setTransientHint: mock() },
        ui: { requestRender: mock() },
      },
      session: { id: 's1' },
      skillCommandMap: options.skillCommandMap ?? new Map(),
      pluginCommandMap: options.pluginCommandMap ?? new Map(),
      steerQueuedMessagesIntoRunningTurn,
      isSteeringQueuedMessages: mock(() => options.steering ?? false),
      updateQueueDisplay,
      validateMediaCapabilities: mock(() => true),
      showError: mock(),
      track: mock(),
      btwPanelController: {
        cancelRunning: mock(() => false),
        closeOrCancel: mock(() => false),
      },
    } as unknown as EditorKeyboardHost;
    const controller = new EditorKeyboardController(host, new ImageAttachmentStore(), clock);
    controller.install();
    const onCtrlS = editor['onCtrlS'];
    if (onCtrlS === undefined) throw new Error('onCtrlS handler not installed');
    return {
      host,
      editor,
      setText,
      steerQueuedMessagesIntoRunningTurn,
      updateQueueDisplay,
      onCtrlS: onCtrlS as () => void,
    };
  }

  it('leaves queued inputs owned by the coordinator until dispatch succeeds', () => {
    const queued: QueuedMessage[] = [
      { text: 'earlier note', agentId: 'main' },
      {
        text: 'check /skill:review',
        agentId: 'main',
        inlineSkillActivations: [{ skillName: 'review' }],
      },
      { text: 'later note', agentId: 'main' },
      { text: '!ls', agentId: 'main', mode: 'bash' },
    ];
    const { host, steerQueuedMessagesIntoRunningTurn, updateQueueDisplay, onCtrlS } =
      createCtrlSHarness({ editorText: '', queued });

    onCtrlS();

    expect(steerQueuedMessagesIntoRunningTurn).toHaveBeenCalledWith(true);
    expect(host.state.queuedMessages).toEqual(queued);
    expect(updateQueueDisplay).toHaveBeenCalled();
  });

  it('ignores Ctrl-S while a queue steer is still in flight', () => {
    const queued = [
      { text: 'already steering', agentId: 'main' },
      { text: 'later text', agentId: 'main' },
    ];
    const { host, setText, steerQueuedMessagesIntoRunningTurn, onCtrlS } = createCtrlSHarness({
      editorText: 'draft',
      queued,
      steering: true,
    });

    onCtrlS();

    expect(steerQueuedMessagesIntoRunningTurn).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(host.state.queuedMessages).toEqual(queued);
  });

  it('includes the draft after a leading grouped skill input', () => {
    const queued = {
      text: 'check /skill:review',
      agentId: 'main',
      inlineSkillActivations: [{ skillName: 'review' }],
    };
    const { host, setText, steerQueuedMessagesIntoRunningTurn, onCtrlS } = createCtrlSHarness({
      editorText: 'later note',
      queued: [queued],
    });

    onCtrlS();

    expect(steerQueuedMessagesIntoRunningTurn).toHaveBeenCalledWith(true);
    expect(host.state.queuedMessages).toEqual([queued, { text: 'later note' }]);
    expect(setText).toHaveBeenCalledWith('');
  });

  it.each([
    ['/skill:review src/app.ts', [{ skillName: 'review', args: 'src/app.ts' }]],
    ['check /skill:review', [{ skillName: 'review' }]],
    ['/skill:review check /skill:review', [{ skillName: 'review' }]],
  ])('parses skill draft %s before asking the coordinator to steer', (text, activations) => {
    const { host, setText, steerQueuedMessagesIntoRunningTurn, onCtrlS } = createCtrlSHarness({
      editorText: text,
      queued: [],
      skillCommandMap: new Map([['skill:review', 'review']]),
    });

    onCtrlS();

    expect(steerQueuedMessagesIntoRunningTurn).toHaveBeenCalledWith(true);
    expect(host.state.queuedMessages).toEqual([
      { text, inlineSkillActivations: activations },
    ]);
    expect(setText).toHaveBeenCalledWith('');
  });
});

describe('EditorKeyboardController survey wiring', () => {
  it('clears the pending undo-escape sequence only when the survey consumes Escape', () => {
    const { editor, openUndoSelector, survey } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    pressEscape(editor);
    survey.handlePreInput.mockReturnValueOnce(true);
    onPreInput('\u001B');
    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledTimes(1);
  });

  it('clears a pending exit when Escape arrives through the survey pre-input hook', () => {
    const { host, editor } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    pressCtrlD(editor);
    onPreInput('\u001B');
    pressCtrlD(editor);

    expect(host.stop).not.toHaveBeenCalled();
  });

  it('routes raw keys to the survey pre-input hook first', () => {
    const { editor, survey } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    survey.handlePreInput.mockReturnValueOnce(true);
    expect(onPreInput('\u001B[D')).toBe(true);
    expect(survey.handlePreInput).toHaveBeenCalledWith('\u001B[D');

    survey.handlePreInput.mockReturnValueOnce(false);
    expect(onPreInput('x')).toBe(false);
  });

  it('forwards editor text changes to the survey', () => {
    const { editor, survey } = createHarness();
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('1');

    expect(survey.handleEditorChange).toHaveBeenCalledWith('1');
  });

  it('lets the survey intercept a submit instead of sending it', () => {
    const { host, editor, survey } = createHarness();
    const onSubmit = editor['onSubmit'] as unknown as (text: string) => void;

    survey.handleSubmit.mockReturnValueOnce(true);
    onSubmit('1');

    expect(survey.handleSubmit).toHaveBeenCalledWith('1');
    expect(host.handleUserInput).not.toHaveBeenCalled();
  });

  it('sends the submit when the survey passes it through', () => {
    const { host, editor, survey } = createHarness();
    const onSubmit = editor['onSubmit'] as unknown as (text: string) => void;

    survey.handleSubmit.mockReturnValueOnce(false);
    onSubmit('hello');

    expect(host.handleUserInput).toHaveBeenCalledWith('hello');
  });

  it('displaces the survey when the external editor opens', () => {
    setEnv('VISUAL', '');
    setEnv('EDITOR', '');
    try {
      const { editor, survey } = createHarness();
      const onOpenExternalEditor = editor['onOpenExternalEditor'] as unknown as () => void;

      onOpenExternalEditor();

      expect(survey.notifyDisplaced).toHaveBeenCalled();
    } finally {
      restoreEnvs();
    }
  });
});

describe('EditorKeyboardController Ctrl+P prompt optimization', () => {
  it('starts an optimization and records the shortcut', () => {
    const { editor, host, promptOptimizer } = createHarness();
    const onOptimizePrompt = editor['onOptimizePrompt'] as unknown as () => void;

    onOptimizePrompt();

    expect(promptOptimizer.optimize).toHaveBeenCalledTimes(1);
    expect(host.track).toHaveBeenCalledWith('shortcut_optimize_prompt');
  });
});
