import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';

import {
  PromptOptimizerController,
  type PromptOptimizerHost,
} from '#/tui/controllers/prompt-optimizer';

void mock.module('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.dialogs.promptOptimize.failed': 'Could not rewrite the prompt: {{error}}',
      'tui.dialogs.promptOptimize.noSession': 'Start a session before rewriting a prompt.',
      'tui.dialogs.promptOptimize.title': 'Rewrite this prompt',
      'tui.dialogs.promptOptimize.hint': '{{accept}} accept · {{discard}} discard',
      'tui.dialogs.promptOptimize.accept': 'Accept rewrite',
      'tui.dialogs.promptOptimize.discard': 'Keep original',
      'tui.dialogs.promptOptimize.busy': 'A rewrite is already in progress.',
      'tui.dialogs.promptOptimize.displaced': 'The rewrite was dismissed by another panel.',
      'tui.dialogs.promptOptimize.unchanged': 'The draft already says this; nothing to rewrite.',
      'tui.dialogs.promptOptimize.disabled':
        'The prompt optimizer is off. Enable the prompt_optimizer experiment in /settings to use Ctrl+P.',
      'tui.dialogs.promptOptimize.attachmentDropped':
        'The rewrite dropped an attached image or video, so your draft was left unchanged.',
    };
    const msg = translations[key] ?? key;
    if (params === undefined) return msg;
    let result = msg;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{{${k}}}`, String(v));
    }
    return result;
  },
}));

interface Harness {
  readonly controller: PromptOptimizerController;
  readonly host: PromptOptimizerHost;
  readonly editor: { getText: Mock<(...args: any[]) => any>; setText: Mock<(...args: any[]) => any> };
  readonly optimizePrompt: Mock<(...args: any[]) => any>;
  readonly showError: Mock<(...args: any[]) => any>;
  readonly showInfo: Mock<(...args: any[]) => any>;
  readonly track: Mock<(...args: any[]) => any>;
  readonly mount: Mock<(...args: any[]) => any>;
  readonly restoreEditor: Mock<(...args: any[]) => any>;
  readonly setEditorOptimizing: Mock<(...args: any[]) => any>;
  readonly mediaIds: Set<number>;
  readonly activity: {
    begin: Mock<(...args: any[]) => any>;
    clear: Mock<(...args: any[]) => any>;
    setPhase: Mock<(...args: any[]) => any>;
    applyEvent: Mock<(...args: any[]) => any>;
  };
  setFlagEnabled(value: boolean): void;
  readonly session: { getContext: Mock<(...args: any[]) => any> };
  lastPanel(): {
    handleInput(data: string): void;
  };
  displace(): void;
}

function createHarness(draft = 'fix the parser'): Harness {
  const editor = {
    getText: mock(() => draft),
    setText: mock(),
  };
  const optimizePrompt = mock(async () => 'Rewrite the parser to reject trailing input.');
  const showError = mock();
  const showInfo = mock();
  const track = mock();
  const mount = mock();
  const restoreEditor = mock();
  const setEditorOptimizing = mock();
  const session = {
    optimizePrompt,
    getContext: mock(async () => ({ history: [], tokenCount: 0 })),
  };

  let panel: { handleInput(data: string): void } | undefined;
  const mediaIds = new Set<number>();
  const activity = {
    begin: mock(),
    clear: mock(),
    setPhase: mock(),
    applyEvent: mock(),
    active: false,
  };
  const flag = { enabled: true };
  let onDisplaced: (() => void) | undefined;
  const host: PromptOptimizerHost = {
    state: {
      editor,
      activeDialog: null,
      terminal: { rows: 40, columns: 80 },
    },
    session,
    ensureSession: mock(async () => session),
    showError,
    showInfo,
    track,
    mediaPlaceholderIds: () => mediaIds,
    promptOptimizerEnabled: () => flag.enabled,
    promptOptimizerActivity: activity,
    mountEditorReplacement: (
      mounted: { handleInput(data: string): void },
      displaced?: () => void,
    ) => {
      panel = mounted;
      onDisplaced = displaced;
      mount(mounted);
    },
    restoreEditor,
    setEditorOptimizing,
  } as unknown as PromptOptimizerHost;

  return {
    controller: new PromptOptimizerController(host),
    host,
    editor,
    optimizePrompt,
    showError,
    showInfo,
    track,
    mediaIds,
    activity,
    setFlagEnabled: (value: boolean) => {
      flag.enabled = value;
    },
    mount,
    restoreEditor,
    setEditorOptimizing,
    session,
    lastPanel: () => {
      if (panel === undefined) throw new Error('no panel mounted');
      return panel;
    },
    displace: () => {
      if (onDisplaced === undefined) throw new Error('no displacement hook mounted');
      const displaced = onDisplaced;
      onDisplaced = undefined;
      displaced();
    },
  };
}

const ESC = '\u001B';
const ENTER = '\r';

describe('PromptOptimizerController', () => {
  beforeEach(() => mock.clearAllMocks());

  it('asks the model and mounts a confirmation panel instead of editing in place', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    expect(h.optimizePrompt).toHaveBeenCalledWith('fix the parser', {
      recentTurns: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(h.editor.setText).not.toHaveBeenCalled();
    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('passes recent user turns as an array for the engine to cap', async () => {
    const h = createHarness();
    h.session.getContext.mockResolvedValueOnce({
      history: [
        { role: 'user', origin: { kind: 'user' }, content: 'first ask' },
        { role: 'assistant', content: 'a reply' },
        { role: 'user', origin: { kind: 'user' }, content: 'second ask' },
      ],
      tokenCount: 0,
    });
    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    expect(h.optimizePrompt).toHaveBeenCalledWith('fix the parser', {
      recentTurns: ['first ask', 'second ask'],
      signal: expect.any(AbortSignal),
    });
    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('applies the rewrite only after the user accepts', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    h.lastPanel().handleInput(ENTER);
    await pending;

    expect(h.editor.setText).toHaveBeenCalledWith(
      'Rewrite the parser to reject trailing input.',
      { preservePasteRegistry: true },
    );
    expect(h.restoreEditor).toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith(
      'prompt_optimize_accepted',
      expect.objectContaining({
        draftChars: 'fix the parser'.length,
        rewriteChars: 'Rewrite the parser to reject trailing input.'.length,
      }),
    );
  });

  it('keeps the original draft when the user discards', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    h.lastPanel().handleInput(ESC);
    await pending;

    expect(h.editor.setText).not.toHaveBeenCalled();
    expect(h.restoreEditor).toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith(
      'prompt_optimize_discarded',
      expect.objectContaining({ draftChars: 'fix the parser'.length }),
    );
  });

  it('shows the editor as busy for the whole rewrite, then clears it', async () => {
    const h = createHarness();
    // Hold the rewrite open so the busy window can be observed while it is
    // pending; resolving it straight away would hide the very interval this
    // signal exists to cover.
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    h.optimizePrompt.mockReturnValueOnce(gate);

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.optimizePrompt).toHaveBeenCalledTimes(1));

    expect(h.setEditorOptimizing).toHaveBeenCalledWith(true);
    // Not cleared while the request is still outstanding.
    expect(h.setEditorOptimizing).toHaveBeenCalledTimes(1);

    release('Rewrite the parser to reject trailing input.');
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    expect(h.setEditorOptimizing).toHaveBeenLastCalledWith(false);

    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('clears the busy state when the rewrite fails', async () => {
    const h = createHarness();
    h.optimizePrompt.mockRejectedValueOnce(new Error('provider exploded'));

    await h.controller.optimize();

    expect(h.setEditorOptimizing).toHaveBeenCalledWith(true);
    expect(h.setEditorOptimizing).toHaveBeenLastCalledWith(false);
  });

  it('clears the busy state when the model returns the draft unchanged', async () => {
    const h = createHarness();
    h.optimizePrompt.mockResolvedValueOnce('fix the parser');

    await h.controller.optimize();

    expect(h.setEditorOptimizing).toHaveBeenLastCalledWith(false);
  });

  it('reports busy before the session is resolved', async () => {
    const h = createHarness();
    const slowContext = new Promise<{ history: never[]; tokenCount: number }>((resolve) => {
      setTimeout(() => resolve({ history: [], tokenCount: 0 }), 5);
    });
    h.session.getContext.mockReturnValueOnce(slowContext);

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.setEditorOptimizing).toHaveBeenCalledWith(true));
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('tells the user a draft is needed instead of returning silently', async () => {
    const h = createHarness('   ');
    await h.controller.optimize();

    expect(h.optimizePrompt).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_empty_draft');
  });

  it('surfaces a failure instead of failing silently', async () => {
    const h = createHarness();
    h.optimizePrompt.mockRejectedValueOnce(new Error('provider exploded'));

    await h.controller.optimize();

    expect(h.showError).toHaveBeenCalledWith(expect.stringContaining('provider exploded'));
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_failed', {
      code: 'unknown',
    });
    expect(h.mount).not.toHaveBeenCalled();
  });

  it('skips the panel when the model returns the draft unchanged', async () => {
    const h = createHarness();
    h.optimizePrompt.mockResolvedValueOnce('fix the parser');

    await h.controller.optimize();

    expect(h.mount).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_unchanged', { reason: 'identical' });
    expect(h.showInfo).toHaveBeenCalledWith(
      'The draft already says this; nothing to rewrite.',
    );
  });

  it('settles the rewrite and clears busy when another panel displaces the panel', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    h.displace();
    await pending;

    // The displaced panel kept the draft and said so; the newer panel still
    // owns the editor slot, so no restore may run.
    expect(h.editor.setText).not.toHaveBeenCalled();
    expect(h.restoreEditor).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_displaced');
    expect(h.setEditorOptimizing).toHaveBeenLastCalledWith(false);

    // `inFlight` is reset, so a later Ctrl+P runs the engine again instead of
    // silently no-oping until the process exits.
    h.optimizePrompt.mockResolvedValueOnce('Rewrite the parser differently.');
    const next = h.controller.optimize();
    await waitForAssertion(() => expect(h.optimizePrompt).toHaveBeenCalledTimes(2));
    h.lastPanel().handleInput(ESC);
    await next;
  });

  it('reports busy instead of returning silently while a rewrite is in flight', async () => {
    const h = createHarness();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    h.optimizePrompt.mockReturnValueOnce(gate);

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.setEditorOptimizing).toHaveBeenCalledWith(true));

    await h.controller.optimize();

    expect(h.optimizePrompt).toHaveBeenCalledTimes(1);
    expect(h.showError).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_busy');

    release('Rewrite the parser to reject trailing input.');
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('cancels the in-flight rewrite on demand and keeps the draft', async () => {
    const h = createHarness();
    let aborted = false;
    h.optimizePrompt.mockImplementationOnce(
      (_text: string, options: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    );

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.optimizePrompt).toHaveBeenCalledTimes(1));

    expect(h.controller.cancelInFlight()).toBe(true);
    await pending;

    expect(aborted).toBe(true);
    expect(h.editor.setText).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.showError).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_cancelled');
    expect(h.setEditorOptimizing).toHaveBeenLastCalledWith(false);
  });

  it('reports nothing to cancel when no rewrite is running', () => {
    const h = createHarness();
    expect(h.controller.cancelInFlight()).toBe(false);
  });

  it('refuses a rewrite that dropped an attached image', async () => {
    const h = createHarness('look at [image #1 (640×480)] and fix it');
    h.mediaIds.add(1);
    h.optimizePrompt.mockResolvedValueOnce('Look at the screenshot and fix the parser.');

    await h.controller.optimize();

    expect(h.mount).not.toHaveBeenCalled();
    expect(h.editor.setText).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledWith(
      'The rewrite dropped an attached image or video, so your draft was left unchanged.',
    );
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_attachment_dropped', { count: 1 });
  });

  it('accepts a rewrite that keeps the attachment placeholder', async () => {
    const h = createHarness('look at [image #1 (640×480)] and fix it');
    h.mediaIds.add(1);
    h.optimizePrompt.mockResolvedValueOnce(
      'Look at [image #1 (640×480)] and fix the parser so it rejects trailing input.',
    );

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    h.lastPanel().handleInput(ENTER);
    await pending;

    expect(h.editor.setText).toHaveBeenCalled();
  });

  it('ignores a user-typed placeholder the store does not own', async () => {
    const h = createHarness('explain what [image #99 (10×10)] means');
    h.optimizePrompt.mockResolvedValueOnce('Explain what the tag means.');

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    h.lastPanel().handleInput(ESC);
    await pending;

    expect(h.showError).not.toHaveBeenCalled();
  });

  it('caps the turns it sends so the engine prompt stays bounded', async () => {
    const h = createHarness();
    h.session.getContext.mockResolvedValueOnce({
      history: Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        origin: { kind: 'user' },
        content: `ask-${i}`,
      })),
      tokenCount: 0,
    });

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));
    h.lastPanel().handleInput(ESC);
    await pending;

    const sent = h.optimizePrompt.mock.calls[0]?.[1] as { recentTurns?: readonly string[] };
    expect(sent.recentTurns).toHaveLength(6);
    expect(sent.recentTurns?.[5]).toBe('ask-9');
  });

  it('says the feature is off instead of asking the engine to refuse', async () => {
    const h = createHarness();
    h.setFlagEnabled(false);

    await h.controller.optimize();

    expect(h.optimizePrompt).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
    expect(h.showError).toHaveBeenCalledWith(
      'The prompt optimizer is off. Enable the prompt_optimizer experiment in /settings to use Ctrl+P.',
    );
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_disabled');
  });

  it('mounts the live status row before the request and clears it when the model answers', async () => {
    const h = createHarness();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    h.optimizePrompt.mockReturnValueOnce(gate);

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.optimizePrompt).toHaveBeenCalledTimes(1));

    expect(h.activity.begin).toHaveBeenCalledTimes(1);
    expect(h.activity.clear).not.toHaveBeenCalled();

    release('Rewrite the parser to reject trailing input.');
    await waitForAssertion(() => expect(h.mount).toHaveBeenCalledTimes(1));

    // Cleared as soon as the rewrite lands, before the user reviews it.
    expect(h.activity.clear).toHaveBeenCalledTimes(1);

    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('clears the live status row when the rewrite fails', async () => {
    const h = createHarness();
    h.optimizePrompt.mockRejectedValueOnce(new Error('provider exploded'));

    await h.controller.optimize();

    expect(h.activity.begin).toHaveBeenCalledTimes(1);
    expect(h.activity.clear).toHaveBeenCalled();
  });

  it('clears the live status row when the user cancels', async () => {
    const h = createHarness();
    h.optimizePrompt.mockImplementationOnce(
      (_text: string, options: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    );

    const pending = h.controller.optimize();
    await waitForAssertion(() => expect(h.optimizePrompt).toHaveBeenCalledTimes(1));
    expect(h.controller.cancelInFlight()).toBe(true);
    await pending;

    expect(h.activity.clear).toHaveBeenCalled();
  });

  it('clears the live status row when the rewrite matches the draft', async () => {
    const h = createHarness();
    h.optimizePrompt.mockResolvedValueOnce('fix the parser');

    await h.controller.optimize();

    // `clear()` is idempotent, so both the post-answer path and the `finally`
    // safety net may reach it; what matters is that the row is gone.
    expect(h.activity.clear).toHaveBeenCalled();
  });

  it('does not mount the live status row when the feature is off', async () => {
    const h = createHarness();
    h.setFlagEnabled(false);

    await h.controller.optimize();

    expect(h.activity.begin).not.toHaveBeenCalled();
  });
});
