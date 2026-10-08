import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PromptOptimizerController,
  type PromptOptimizerHost,
} from '#/tui/controllers/prompt-optimizer';

vi.mock('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.dialogs.promptOptimize.failed': 'Could not rewrite the prompt: {{error}}',
      'tui.dialogs.promptOptimize.noSession': 'Start a session before rewriting a prompt.',
      'tui.dialogs.promptOptimize.title': 'Rewrite this prompt',
      'tui.dialogs.promptOptimize.hint': '{{accept}} accept · {{discard}} discard',
      'tui.dialogs.promptOptimize.accept': 'Accept rewrite',
      'tui.dialogs.promptOptimize.discard': 'Keep original',
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
  readonly editor: { getText: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> };
  readonly optimizePrompt: ReturnType<typeof vi.fn>;
  readonly showError: ReturnType<typeof vi.fn>;
  readonly track: ReturnType<typeof vi.fn>;
  readonly mount: ReturnType<typeof vi.fn>;
  readonly restoreEditor: ReturnType<typeof vi.fn>;
  readonly session: { getContext: ReturnType<typeof vi.fn> };
  lastPanel(): {
    handleInput(data: string): void;
  };
}

function createHarness(draft = 'fix the parser'): Harness {
  const editor = {
    getText: vi.fn(() => draft),
    setText: vi.fn(),
  };
  const optimizePrompt = vi.fn(async () => 'Rewrite the parser to reject trailing input.');
  const showError = vi.fn();
  const track = vi.fn();
  const mount = vi.fn();
  const restoreEditor = vi.fn();
  const session = {
    optimizePrompt,
    getContext: vi.fn(async () => ({ history: [], tokenCount: 0 })),
  };

  let panel: { handleInput(data: string): void } | undefined;
  const host: PromptOptimizerHost = {
    state: {
      editor,
      activeDialog: null,
    },
    session,
    ensureSession: vi.fn(async () => session),
    showError,
    track,
    mountEditorReplacement: (mounted: { handleInput(data: string): void }) => {
      panel = mounted;
      mount(mounted);
    },
    restoreEditor,
  } as unknown as PromptOptimizerHost;

  return {
    controller: new PromptOptimizerController(host),
    host,
    editor,
    optimizePrompt,
    showError,
    track,
    mount,
    restoreEditor,
    session,
    lastPanel: () => {
      if (panel === undefined) throw new Error('no panel mounted');
      return panel;
    },
  };
}

const ESC = '\u001B';
const ENTER = '\r';

describe('PromptOptimizerController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the model and mounts a confirmation panel instead of editing in place', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await vi.waitFor(() => expect(h.mount).toHaveBeenCalledOnce());

    expect(h.optimizePrompt).toHaveBeenCalledWith('fix the parser', { recentTurns: undefined });
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
    await vi.waitFor(() => expect(h.mount).toHaveBeenCalledOnce());

    expect(h.optimizePrompt).toHaveBeenCalledWith('fix the parser', {
      recentTurns: ['first ask', 'second ask'],
    });
    h.lastPanel().handleInput(ESC);
    await pending;
  });

  it('applies the rewrite only after the user accepts', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await vi.waitFor(() => expect(h.mount).toHaveBeenCalledOnce());

    h.lastPanel().handleInput(ENTER);
    await pending;

    expect(h.editor.setText).toHaveBeenCalledWith(
      'Rewrite the parser to reject trailing input.',
      { preservePasteRegistry: true },
    );
    expect(h.restoreEditor).toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_accepted');
  });

  it('keeps the original draft when the user discards', async () => {
    const h = createHarness();
    const pending = h.controller.optimize();
    await vi.waitFor(() => expect(h.mount).toHaveBeenCalledOnce());

    h.lastPanel().handleInput(ESC);
    await pending;

    expect(h.editor.setText).not.toHaveBeenCalled();
    expect(h.restoreEditor).toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_discarded');
  });

  it('does nothing for an empty draft', async () => {
    const h = createHarness('   ');
    await h.controller.optimize();

    expect(h.optimizePrompt).not.toHaveBeenCalled();
    expect(h.mount).not.toHaveBeenCalled();
  });

  it('surfaces a failure instead of failing silently', async () => {
    const h = createHarness();
    h.optimizePrompt.mockRejectedValueOnce(new Error('provider exploded'));

    await h.controller.optimize();

    expect(h.showError).toHaveBeenCalledWith(expect.stringContaining('provider exploded'));
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_failed');
    expect(h.mount).not.toHaveBeenCalled();
  });

  it('skips the panel when the model returns the draft unchanged', async () => {
    const h = createHarness();
    h.optimizePrompt.mockResolvedValueOnce('fix the parser');

    await h.controller.optimize();

    expect(h.mount).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith('prompt_optimize_unchanged');
  });
});
