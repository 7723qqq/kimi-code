/**
 * Scenario: /secondary-model command behavior in the interactive TUI.
 * Responsibilities: picker filtering, persistence of `[secondary_model] default_model`
 * (keeping existing pool descriptions), and error paths.
 * Wiring: real command and selector with the SDK/session boundaries stubbed by a small host rig.
 * Run: cd apps/kimi-code && bun test --isolate test/tui/commands/secondary-model.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock, type Mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';

import type { SlashCommandHost } from '#/tui/commands';
import { handleSecondaryModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly title?: string;
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: { alias: string }) => void;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly secondaryModel?: { defaultModel?: string; models?: Record<string, string> };
}) {
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
      // The v1 derived entry must never be selectable.
      '__secondary__': model('cheap'),
      // The pool's reserved symbolic choice must never be selectable either.
      'primary': model('primary'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: mock(async () => undefined),
    },
    harness: {
      getConfig: mock(async () => ({
        providers: {},
        secondaryModel: options?.secondaryModel,
      })),
      setConfig: mock(async () => ({})),
    },
    setAppState: mock((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: mock(),
    restoreEditor: mock(),
    showStatus: mock(),
    showError: mock(),
    showNotice: mock(),
    track: mock(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: Mock<(...args: any[]) => any>;
      setConfig: Mock<(...args: any[]) => any>;
    };
    mountEditorReplacement: Mock<(...args: any[]) => any>;
    showStatus: Mock<(...args: any[]) => any>;
    showError: Mock<(...args: any[]) => any>;
    showNotice: Mock<(...args: any[]) => any>;
  };
  return { host };
}

function mountedPicker(host: { mountEditorReplacement: Mock<(...args: any[]) => any> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleSecondaryModelCommand', () => {
  it('opens the picker filtered to user models, with the configured default as current', async () => {
    const { host } = makeHost({ secondaryModel: { defaultModel: 'cheap' } });

    await handleSecondaryModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('secondary model');
    // Pool bindings carry no explicit thinking level — the picker hides the
    // Thinking footer instead of offering a no-op choice.
    expect(opts.thinkingControl).toBe(false);
  });

  it('persists only default_model when no pool exists (implicit single-entry pool)', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await waitForAssertion(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { defaultModel: 'k2' },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('adds the picked alias to an existing pool with an empty description', async () => {
    const { host } = makeHost({
      secondaryModel: {
        defaultModel: 'cheap',
        models: { cheap: 'fast and cheap' },
      },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await waitForAssertion(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: {
        defaultModel: 'k2',
        models: { cheap: 'fast and cheap', k2: '' },
      },
    });
  });

  it('keeps existing pool descriptions and other pool entries on save', async () => {
    const { host } = makeHost({
      secondaryModel: {
        defaultModel: 'cheap',
        models: { cheap: 'fast and cheap', k2: 'hard tasks' },
      },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await waitForAssertion(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: {
        defaultModel: 'k2',
        models: { cheap: 'fast and cheap', k2: 'hard tasks' },
      },
    });
  });

  it('pre-selects a valid alias argument instead of erroring', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'cheap');

    const opts = mountedPicker(host);
    expect(opts.selectedValue).toBe('cheap');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the synthesized derived alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '__secondary__');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: __secondary__');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the reserved primary alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'primary');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports the reserved error for primary even when it is the only configured model', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = { primary: model('primary') };

    await handleSecondaryModelCommand(host, 'primary');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleSecondaryModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await waitForAssertion(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
