/**
 * Scenario: /provider add (manual) + edit wiring, plus the post-add
 * default-model selection.
 * Responsibilities: the manual add path writes exactly one `buildAddPatch`,
 * refreshes and lands on the model selector; the edit path prefills from config,
 * refuses colliding writes, and applies a rename as `removeProvider` +
 * `setConfig`; the picked effort is gated for persistence by the model's
 * effective default, and a session-only pick is still applied to the runtime
 * after the config refresh (which only reactivates from persisted values).
 * Wiring: real command handlers with the harness / authFlow boundaries stubbed
 * by a host rig over an in-memory config document.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider.test.ts
 */
import {
  removeProviderFromConfig,
  type KimiConfig,
  type KimiConfigPatch,
  type ModelAlias,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { t } from '#/i18n';
import type { SlashCommandHost } from '#/tui/commands';
import { handleProviderCommand, setDefaultModel } from '#/tui/commands/provider';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { CustomRegistryImportDialogComponent } from '#/tui/components/dialogs/custom-registry-import';
import { ProviderFormDialogComponent } from '#/tui/components/dialogs/provider-form-dialog';
import { ProviderManagerComponent } from '#/tui/components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { buildAddPatch, type ProviderFormValue } from '#/utils/provider-form';

function makeHost(
  options: {
    refreshReachedLiveSession?: boolean;
    activateReachedLiveSession?: boolean;
  } = {},
) {
  const appState = {
    availableModels: {
      // Declares no efforts; the Anthropic profile inference supplies
      // [low, medium, high, xhigh, max] with the default resolved to 'high'.
      opus: {
        provider: 'compatible',
        model: 'claude-opus-4-7',
        maxContextSize: 200_000,
      } as unknown as ModelAlias,
    },
    availableProviders: {
      compatible: { type: 'anthropic' },
    },
  };
  const host = {
    state: { appState },
    waitForLazyCreation: vi.fn(async () => {}),
    harness: {
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => options.refreshReachedLiveSession === true),
      activateModelAfterLogin: vi.fn(async () => options.activateReachedLiveSession === true),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    authFlow: {
      refreshConfigAfterLogin: ReturnType<typeof vi.fn>;
      activateModelAfterLogin: ReturnType<typeof vi.fn>;
    };
    waitForLazyCreation: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return { host };
}

describe('setDefaultModel', () => {
  it('applies an above-default pick to the runtime when the gate keeps it session-only', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    // The application must come after the refresh, or the persisted value
    // reactivated by refreshConfigAfterLogin would clobber the pick.
    expect(host.authFlow.activateModelAfterLogin.mock.invocationCallOrder[0]!).toBeGreaterThan(
      host.authFlow.refreshConfigAfterLogin.mock.invocationCallOrder[0]!,
    );
    // Without a session the engine never sees the pick, so the TUI stays the
    // sole model_switch producer.
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('does not re-apply the effort when the pick persists', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('does not re-apply a boolean on pick', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'on');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when activation changed the bound alias', async () => {
    const { host } = makeHost({ refreshReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'high');

    // refreshConfigAfterLogin routed through session.setModel with a changed
    // alias, which the engine already tracks — a TUI-side event would
    // double-count the switch.
    expect(host.track).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when a lazy session came live mid-flow and rebounded', async () => {
    // Session-less at entry, but the first prompt's lazy creation completes
    // while setConfig / the refresh are pending, so the session-only re-apply
    // lands on the now-live session and actually switches its alias (engine
    // emits).
    const { host } = makeHost({ activateReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).not.toHaveBeenCalled();
  });

  it('emits model_switch when a v1-created session only rebinds the same alias', async () => {
    // v1 session-less + session-only effort: the refresh creates the session
    // with the picked model (creation emits nothing), then the re-apply
    // reaches that live session but its setModel is an alias no-op (no engine
    // event either) — the TUI must stay the producer for the pick.
    const { host } = makeHost({
      refreshReachedLiveSession: false,
      activateReachedLiveSession: false,
    });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('waits for an in-flight lazy creation before activating (v2)', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.waitForLazyCreation).toHaveBeenCalled();
    expect(host.waitForLazyCreation.mock.invocationCallOrder[0]!).toBeLessThan(
      host.harness.setConfig.mock.invocationCallOrder[0]!,
    );
  });
});

// ---------------------------------------------------------------------------
// /provider add (manual) + edit (E) wiring
// ---------------------------------------------------------------------------

const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const TAB = '\t';
const ENTER = '\r';
const CTRL_E = '\u0005';
const CTRL_R = '\u0012';
const BACKSPACE = '\u007F';

// CSI color/reset sequences plus pi-tui's IME cursor marker.
const ANSI = /\u001B\[[0-9;]*m|\u001B_pi:c\u0007/g;

/** An editor replacement: focusable and always key-driven (`handleInput` is optional on Component). */
type Panel = Component & Focusable & { handleInput(data: string): void };

/** The rig host with the stubbed boundaries kept mock-typed for assertions. */
type RigHost = SlashCommandHost & {
  harness: {
    getConfig: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    removeProvider: ReturnType<typeof vi.fn>;
    supportsAtomicSectionReplace: ReturnType<typeof vi.fn>;
    replaceConfigSections: ReturnType<typeof vi.fn>;
    importCustomRegistry: ReturnType<typeof vi.fn>;
  };
  authFlow: { refreshConfigAfterLogin: ReturnType<typeof vi.fn> };
  restoreEditor: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
};

interface CommandRig {
  host: RigHost;
  mounted: Panel[];
  /** Clone of the live config document the stubbed harness reads and writes. */
  readConfig: () => KimiConfig;
}

/** The `setConfig` contract used by the rig: sections merge by key, rest replaces. */
function applyPatch(config: KimiConfig, patch: KimiConfigPatch): KimiConfig {
  // The command-side patches carry whole records, so the merged document is a
  // `KimiConfig`; the cast only re-widens the partial section types.
  return {
    ...config,
    ...patch,
    providers: { ...config.providers, ...patch.providers },
    models: { ...config.models, ...patch.models },
  } as KimiConfig;
}

/**
 * The `replaceConfigSections` contract used by the rig: a section is replaced
 * wholesale and `undefined` clears it — the engine's own reading of the call
 * (`configService.replaceSections`), which is the opposite of `setConfig`'s
 * "skip an undefined domain". A rig that got this backwards would pass while
 * the real v2 host silently kept a pointer the write meant to drop.
 */
function applySections(config: KimiConfig, sections: Record<string, unknown>): KimiConfig {
  const next = structuredClone(config) as Record<string, unknown>;
  for (const [domain, value] of Object.entries(sections)) {
    if (value === undefined) {
      delete next[domain];
    } else {
      next[domain] = structuredClone(value);
    }
  }
  return next as KimiConfig;
}

interface RigOptions {
  /**
   * Model a host that can land several sections in ONE write (the v2 engine).
   * Without it the rig is a v1-style host: `supportsAtomicSectionReplace()` is
   * false and a replacing write goes through the `removeProvider` + `setConfig`
   * pair instead.
   */
  readonly atomicSections?: boolean;
}

function makeCommandRig(initial: KimiConfig, options: RigOptions = {}): CommandRig {
  let store = structuredClone(initial);
  const mounted: Panel[] = [];
  const atomicSections = options.atomicSections === true;
  const harness = {
    getConfig: vi.fn(() => Promise.resolve(structuredClone(store))),
    setConfig: vi.fn((patch: KimiConfigPatch) => {
      store = applyPatch(store, patch);
      return Promise.resolve(structuredClone(store));
    }),
    removeProvider: vi.fn((providerId: string) => {
      store = removeProviderFromConfig(store, providerId);
      return Promise.resolve(structuredClone(store));
    }),
    supportsAtomicSectionReplace: vi.fn(() => atomicSections),
    replaceConfigSections: vi.fn((sections: Record<string, unknown>) => {
      store = applySections(store, sections);
      return Promise.resolve();
    }),
    importCustomRegistry: vi.fn(() => Promise.resolve({ providers: [], credentialEnv: {} })),
  };
  const host = {
    state: {
      appState: {
        availableModels: store.models ?? {},
        availableProviders: store.providers ?? {},
        model: '',
      },
    },
    session: undefined,
    cancelInFlight: undefined,
    deferUserMessages: false,
    harness,
    authFlow: { refreshConfigAfterLogin: vi.fn(() => Promise.resolve(false)) },
    mountEditorReplacement: vi.fn((panel: Panel) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
  } as unknown as RigHost;
  return { host, mounted, readConfig: () => structuredClone(store) };
}

/** Waits until the most recently mounted panel is an instance of `ctor`. */
async function waitForPanel<T extends Panel>(
  rig: CommandRig,
  ctor: new (...args: never[]) => T,
): Promise<T> {
  await vi.waitFor(() => {
    if (!(rig.mounted.at(-1) instanceof ctor)) throw new Error(`no ${ctor.name} mounted yet`);
  });
  return rig.mounted.at(-1) as T;
}

/** The panel currently replacing the editor (its caller just asserted its type). */
function currentPanel<T extends Panel>(rig: CommandRig): T {
  return rig.mounted.at(-1) as T;
}

function plain(panel: Panel, width = 80): string {
  return panel
    .render(width)
    .map((line) => line.replaceAll(ANSI, ''))
    .join('\n');
}

function typeText(panel: Panel, text: string): void {
  for (const ch of text) panel.handleInput(ch);
}

function setConfigPatch(host: RigHost): KimiConfigPatch | undefined {
  const call = host.harness.setConfig.mock.calls.at(-1);
  return call === undefined ? undefined : (call[0] as KimiConfigPatch);
}

const EMPTY_CONFIG: KimiConfig = { providers: {}, models: {} };

const EDIT_CONFIG: KimiConfig = {
  providers: {
    demo: { type: 'openai', apiKey: 'sk-old', baseUrl: 'https://api.example.com/v1' },
  },
  models: {
    'demo/gpt-4.1': {
      provider: 'demo',
      model: 'gpt-4.1',
      maxContextSize: 128000,
      capabilities: ['tool_use', 'thinking'],
      adaptiveThinking: true,
      displayName: 'GPT-4.1',
    },
  },
  defaultModel: 'demo/gpt-4.1',
};

/** An alias that declares every optional field the edit form now owns. */
const RICH_CONFIG: KimiConfig = {
  providers: {
    demo: { type: 'openai', apiKey: 'sk-old', baseUrl: 'https://api.example.com/v1' },
  },
  models: {
    'demo/gpt-4.1': {
      provider: 'demo',
      model: 'gpt-4.1',
      maxContextSize: 128000,
      displayName: 'GPT-4.1',
      capabilities: ['tool_use', 'image_in'],
      maxInputSize: 272000,
      maxOutputSize: 8192,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      offEffort: 'none',
      adaptiveThinking: true,
    },
  },
  defaultModel: 'demo/gpt-4.1',
};

/**
 * A provider and alias that declare every field the form now owns — including
 * the credential as an environment variable (the inline key and the variable
 * are mutually exclusive) and a declared-EMPTY effort ladder.
 */
const OPTIONAL_CONFIG: KimiConfig = {
  providers: {
    demo: {
      type: 'openai',
      apiKeyEnv: 'DEMO_API_KEY',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'X-Tenant': 'acme' },
      env: { REGION: 'cn' },
    },
  },
  models: {
    'demo/gpt-4.1': {
      provider: 'demo',
      model: 'gpt-4.1',
      maxContextSize: 128000,
      displayName: 'GPT-4.1',
      supportEfforts: [],
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://alt.example.com/v1',
      overrides: { maxContextSize: 100000 },
    },
  },
  defaultModel: 'demo/gpt-4.1',
};

/** Two aliases on one provider, so a row deletion is visible in the patch. */
const TWO_MODEL_CONFIG: KimiConfig = {
  providers: {
    demo: { type: 'openai', apiKey: 'sk-old', baseUrl: 'https://api.example.com/v1' },
  },
  models: {
    'demo/gpt-4.1': { provider: 'demo', model: 'gpt-4.1', maxContextSize: 128000 },
    'demo/gpt-5': { provider: 'demo', model: 'gpt-5', maxContextSize: 400000 },
  },
};

const MANAGED_CONFIG: KimiConfig = {
  providers: {
    'corp-oauth': {
      type: 'kimi',
      apiKey: 'sk-managed',
      baseUrl: 'https://managed.example.com/v1',
      oauth: { storage: 'file', key: 'corp-oauth' },
    },
  },
  models: {
    'corp-oauth/kimi-k3': { provider: 'corp-oauth', model: 'kimi-k3', maxContextSize: 262144 },
  },
};

/** Drives `/provider` → add → manual and returns the mounted form. */
async function openManualAddForm(rig: CommandRig): Promise<ProviderFormDialogComponent> {
  await handleProviderCommand(rig.host);
  expect(rig.mounted.at(-1)).toBeInstanceOf(ProviderManagerComponent);
  // The synthetic add row is pinned last and Down clamps at the end, so walking
  // down lands on it whatever the configured providers are.
  const manager = currentPanel<ProviderManagerComponent>(rig);
  for (let i = 0; i < 10; i++) manager.handleInput(DOWN);
  manager.handleInput(ENTER); // [ Add New Platform ]
  const picker = await waitForPanel(rig, ChoicePickerComponent);
  picker.handleInput(DOWN); // known → custom
  picker.handleInput(DOWN); // custom → manual
  picker.handleInput(ENTER);
  const form = await waitForPanel(rig, ProviderFormDialogComponent);
  form.focused = true;
  return form;
}

/** Drives `/provider` → `E` on the highlighted row and returns the mounted form. */
async function openEditForm(rig: CommandRig): Promise<ProviderFormDialogComponent> {
  await handleProviderCommand(rig.host);
  expect(rig.mounted.at(-1)).toBeInstanceOf(ProviderManagerComponent);
  currentPanel<ProviderManagerComponent>(rig).handleInput('E');
  const form = await waitForPanel(rig, ProviderFormDialogComponent);
  form.focused = true;
  return form;
}

/** Enters `demo` into a prefilled field: cursor to the end, erase, then type. */
function replaceText(form: ProviderFormDialogComponent, current: string, next: string): void {
  form.handleInput(CTRL_E); // cursor to the end of the prefilled value
  for (let i = 0; i < current.length; i++) form.handleInput(BACKSPACE);
  typeText(form, next);
}

/** Enter presses from Max input tokens through the row's write back. */
const ROW_TO_COMMIT_FROM_MAX_INPUT = 12;

/** Fills the add form and submits it from the save field. */
function fillAddForm(
  form: ProviderFormDialogComponent,
  value: { id: string; apiKey: string; baseUrl: string; model: string; context: string },
): void {
  typeText(form, value.id);
  form.handleInput(ENTER); // id -> type
  form.handleInput(ENTER); // type -> apiKey
  typeText(form, value.apiKey);
  form.handleInput(ENTER); // apiKey -> apiKeyEnv
  form.handleInput(ENTER); // apiKeyEnv -> baseUrl (the key is inline, not a variable)
  typeText(form, value.baseUrl);
  form.handleInput(ENTER); // baseUrl -> defaultModel
  form.handleInput(ENTER); // defaultModel -> customHeaders
  form.handleInput(ENTER); // customHeaders -> env
  form.handleInput(ENTER); // env -> models
  form.handleInput(ENTER); // open the row editor
  typeText(form, value.model);
  form.handleInput(ENTER); // model -> context
  typeText(form, value.context);
  form.handleInput(ENTER); // context -> max input
  // The optional tail, then the row's write back.
  for (let i = 0; i < ROW_TO_COMMIT_FROM_MAX_INPUT; i++) form.handleInput(ENTER);
  form.handleInput(TAB); // models -> save
  form.handleInput(ENTER); // submit
}

describe('/provider add → manual', () => {
  it('offers the manual entry next to the catalog and registry options', async () => {
    const rig = makeCommandRig(EMPTY_CONFIG);
    await handleProviderCommand(rig.host);
    currentPanel<ProviderManagerComponent>(rig).handleInput(ENTER);
    const picker = await waitForPanel(rig, ChoicePickerComponent);

    const out = plain(picker, 120);
    expect(out).toContain(t('tui.statusMessages.knownThirdPartyProvider'));
    expect(out).toContain(t('tui.statusMessages.customRegistryOption'));
    expect(out).toContain(t('tui.statusMessages.manualProviderOption'));
  });

  it('writes the filled provider once, refreshes, and lands on the model selector', async () => {
    const rig = makeCommandRig(EMPTY_CONFIG);
    const form = await openManualAddForm(rig);
    fillAddForm(form, {
      id: 'demo',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4.1',
      context: '128000',
    });

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalledTimes(1);
    });
    const value: ProviderFormValue = {
      id: 'demo',
      type: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: '' }],
    };
    expect(rig.host.harness.setConfig).toHaveBeenCalledWith(buildAddPatch(value));
    expect(rig.host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledTimes(1);

    const written = rig.readConfig();
    expect(written.providers['demo']).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });
    expect(Object.keys(written.models ?? {})).toEqual(['demo/gpt-4.1']);
    expect(written).not.toHaveProperty('thinking');
    expect(written).not.toHaveProperty('defaultModel');

    await waitForPanel(rig, TabbedModelSelectorComponent);
  });

  it('leaves the config untouched when the form is cancelled', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    const form = await openManualAddForm(rig);
    typeText(form, 'demo');
    form.handleInput(ESC);

    await waitForPanel(rig, ProviderManagerComponent); // back to the list
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(EDIT_CONFIG);
  });

  it('reports a write failure and keeps the previous config', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    rig.host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));
    const form = await openManualAddForm(rig);
    fillAddForm(form, {
      id: 'fresh',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4.1',
      context: '128000',
    });

    await vi.waitFor(() => {
      expect(rig.host.showError).toHaveBeenCalledWith(
        t('tui.statusMessages.providerFormFailed', { error: 'disk full' }),
      );
    });
    expect(rig.host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(EDIT_CONFIG);
  });

  it('refuses an id that already exists instead of merging over it', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    const form = await openManualAddForm(rig);
    fillAddForm(form, {
      id: 'demo',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4.1',
      context: '128000',
    });

    await vi.waitFor(() => {
      expect(rig.host.showError).toHaveBeenCalledWith(
        t('tui.statusMessages.providerFormFailed', {
          error: `${t('tui.dialogs.providerForm.error.idTaken')} (demo)`,
        }),
      );
    });
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(EDIT_CONFIG);
  });
});

describe('/provider add → custom registry (existing path)', () => {
  it('imports through the registry dialog and ends on the model selector', async () => {
    const rig = makeCommandRig(EMPTY_CONFIG);
    rig.host.harness.importCustomRegistry.mockResolvedValueOnce({
      providers: [{ id: 'acme' }],
      credentialEnv: {},
    });
    await handleProviderCommand(rig.host);
    currentPanel<ProviderManagerComponent>(rig).handleInput(ENTER);
    const picker = await waitForPanel(rig, ChoicePickerComponent);
    picker.handleInput(DOWN); // known → custom
    picker.handleInput(ENTER);

    const dialog = await waitForPanel(rig, CustomRegistryImportDialogComponent);
    typeText(dialog, 'https://registry.test/api.json');
    dialog.handleInput(ENTER); // url -> token
    typeText(dialog, 'sk-reg');
    dialog.handleInput(ENTER); // submit

    await vi.waitFor(() => {
      expect(rig.host.harness.importCustomRegistry).toHaveBeenCalledWith({
        url: 'https://registry.test/api.json',
        apiKey: 'sk-reg',
        setDefaultWhenUnset: false,
      });
    });
    expect(rig.host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledTimes(1);
    await waitForPanel(rig, TabbedModelSelectorComponent);
  });
});

describe('/provider edit (E)', () => {
  it('prefills every field from config, including the stored API key', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    const form = await openEditForm(rig);

    expect(form.disabled).toBe(false);
    const out = plain(form);
    expect(out).toContain(t('tui.dialogs.providerForm.titleEdit'));
    expect(out).toContain('demo');
    expect(out).toContain('‹ openai ›');
    expect(out).toContain('https://api.example.com/v1');
    expect(out).toContain('1. gpt-4.1');
    expect(out).not.toContain('sk-old'); // masked until revealed

    form.handleInput(ENTER); // id -> type
    form.handleInput(ENTER); // type -> apiKey
    form.handleInput(CTRL_R); // reveal
    expect(plain(form)).toContain('sk-old');

    form.handleInput(ESC);
    await waitForPanel(rig, ProviderManagerComponent);
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(EDIT_CONFIG);
  });

  it('prefills the optional alias fields and writes them back untouched', async () => {
    const rig = makeCommandRig(RICH_CONFIG);
    const form = await openEditForm(rig);

    for (let i = 0; i < 8; i++) form.handleInput(TAB); // id → models
    form.handleInput(ENTER); // open the row editor
    const out = plain(form);
    expect(out).toContain('Capabilities: tool_use, image_in');
    expect(out).toContain('272000');
    expect(out).toContain('8192');
    expect(out).toContain('low, high');
    const adaptiveLabel = t('tui.dialogs.providerForm.adaptiveThinkingLabel');
    expect(out).toContain(`${adaptiveLabel}  ${t('tui.dialogs.providerForm.toggleEnabled')}`);

    for (let i = 0; i < 14; i++) form.handleInput(ENTER); // walk the row to the commit
    form.handleInput(TAB); // models → save
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalledTimes(1);
    });
    // Prefilling the row and committing it back must be a no-op: every value
    // the alias declared reached the editor and returned unchanged.
    expect(rig.readConfig().models?.['demo/gpt-4.1']).toMatchObject({
      capabilities: ['tool_use', 'image_in'],
      maxInputSize: 272000,
      maxOutputSize: 8192,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      offEffort: 'none',
      adaptiveThinking: true,
      displayName: 'GPT-4.1',
    });
  });

  it('prefills and writes back the provider and alias fields the form owns in full', async () => {
    const rig = makeCommandRig(OPTIONAL_CONFIG);
    const form = await openEditForm(rig);

    const out = plain(form);
    expect(out).toContain('DEMO_API_KEY'); // the credential is a variable name
    expect(out).toContain('X-Tenant=acme');
    expect(out).toContain('REGION=cn');
    expect(out).toContain('gpt-4.1'); // the bare id behind the demo/gpt-4.1 pointer

    for (let i = 0; i < 8; i++) form.handleInput(TAB); // id → models
    form.handleInput(ENTER); // open the row editor
    const row = plain(form, 200);
    expect(row).toContain('> []'); // the declared-empty ladder keeps its literal
    expect(row).toContain('‹ anthropic ›');
    expect(row).toContain('reasoning_content');
    expect(row).toContain('https://alt.example.com/v1');
    expect(row).toContain(t('tui.dialogs.providerForm.overridesNotice'));

    for (let i = 0; i < 14; i++) form.handleInput(ENTER); // walk the row to the commit
    form.handleInput(TAB); // models → save
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalledTimes(1);
    });
    // Every field the record declared reached the form and came back unchanged:
    // `[]`, `false` and "absent" are declarations of their own, and none of them
    // was folded into another state on the way through.
    expect(rig.readConfig().providers['demo']).toMatchObject({
      type: 'openai',
      apiKeyEnv: 'DEMO_API_KEY',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'X-Tenant': 'acme' },
      env: { REGION: 'cn' },
    });
    expect(rig.readConfig().models?.['demo/gpt-4.1']).toMatchObject({
      supportEfforts: [],
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://alt.example.com/v1',
      overrides: { maxContextSize: 100000 },
    });
  });

  it('writes only the alias fields the form owns, without inventing the rest', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    const form = await openEditForm(rig);

    for (let i = 0; i < 9; i++) form.handleInput(TAB); // id → save
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalledTimes(1);
    });
    // capabilities / adaptiveThinking were declared and round-trip; the
    // optional fields the alias never declared must not appear just because
    // the form now owns them.
    expect(rig.readConfig().models?.['demo/gpt-4.1']).toEqual({
      provider: 'demo',
      model: 'gpt-4.1',
      maxContextSize: 128000,
      capabilities: ['tool_use', 'thinking'],
      adaptiveThinking: true,
      displayName: 'GPT-4.1',
    });
  });

  it('renames through removeProvider + setConfig and leaves no old id behind', async () => {
    const rig = makeCommandRig(EDIT_CONFIG);
    const form = await openEditForm(rig);

    replaceText(form, 'demo', 'demo2');
    for (let i = 0; i < 9; i++) form.handleInput(TAB); // id → save
    form.handleInput(ENTER);

    // Re-mounting the list is the flow's last step, so both writes have landed.
    await waitForPanel(rig, ProviderManagerComponent);
    const written = rig.readConfig();
    expect(written.providers['demo']).toBeUndefined();
    expect(Object.keys(written.providers)).toEqual(['demo2']);
    expect(Object.keys(written.models ?? {}).filter((key) => key.startsWith('demo/'))).toEqual([]);
    expect(written.defaultModel).toBe('demo2/gpt-4.1');

    // The removal must run first: the merge alone cannot drop the old keys.
    expect(rig.host.harness.removeProvider).toHaveBeenCalledWith('demo');
    const removeOrder = rig.host.harness.removeProvider.mock.invocationCallOrder[0] as number;
    const setOrder = rig.host.harness.setConfig.mock.invocationCallOrder[0] as number;
    expect(removeOrder).toBeLessThan(setOrder);

    const patch = setConfigPatch(rig.host);
    expect(Object.keys(patch?.models ?? {})).toEqual(['demo2/gpt-4.1']);
    expect(patch?.providers?.['demo2']).toEqual({
      type: 'openai',
      apiKey: 'sk-old',
      baseUrl: 'https://api.example.com/v1',
    });
    expect(patch?.defaultModel).toBe('demo2/gpt-4.1');
  });

  it('drops a deleted model row from the written aliases', async () => {
    const rig = makeCommandRig(TWO_MODEL_CONFIG);
    const form = await openEditForm(rig);

    for (let i = 0; i < 8; i++) form.handleInput(TAB); // id → models
    form.handleInput(DOWN); // row 2
    form.handleInput('D'); // delete row 2
    form.handleInput(TAB); // models → save
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalledTimes(1);
    });
    const patch = setConfigPatch(rig.host);
    expect(Object.keys(patch?.models ?? {})).toEqual(['demo/gpt-4.1']);

    await waitForPanel(rig, ProviderManagerComponent);
    expect(rig.readConfig().models?.['demo/gpt-5']).toBeUndefined();
  });

  it('refuses a rename onto an id another provider already uses', async () => {
    const initial: KimiConfig = {
      providers: {
        demo: { type: 'openai', apiKey: 'sk-old', baseUrl: 'https://api.example.com/v1' },
        taken: { type: 'openai', baseUrl: 'https://taken.example.com/v1' },
      },
      models: { 'demo/gpt-4.1': { provider: 'demo', model: 'gpt-4.1', maxContextSize: 128000 } },
    };
    const rig = makeCommandRig(initial);
    const form = await openEditForm(rig);

    replaceText(form, 'demo', 'taken');
    for (let i = 0; i < 9; i++) form.handleInput(TAB); // id → save
    form.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(rig.host.showError).toHaveBeenCalledWith(
        t('tui.statusMessages.providerFormFailed', {
          error: `${t('tui.dialogs.providerForm.error.idTaken')} (taken)`,
        }),
      );
    });
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.host.harness.removeProvider).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(initial);
  });

  it('renders a managed provider read-only and never writes', async () => {
    const rig = makeCommandRig(MANAGED_CONFIG);
    const form = await openEditForm(rig);

    expect(form.disabled).toBe(true);
    const out = plain(form);
    expect(out).toContain(t('tui.dialogs.providerForm.managedReadonly'));
    expect(out).not.toContain(t('tui.dialogs.providerForm.footerSave'));
    // The stored credential is prefilled, but the read-only rendering must
    // never show it in clear text.
    expect(out).not.toContain('sk-managed');

    for (const key of ['x', TAB, ENTER, 'E', 'D', CTRL_R]) form.handleInput(key);
    expect(plain(form)).not.toContain('sk-managed');
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();

    form.handleInput(ESC);
    await waitForPanel(rig, ProviderManagerComponent);
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.host.harness.removeProvider).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(MANAGED_CONFIG);
  });

  it('edits a provider whose type the form cannot offer without rewriting it', async () => {
    const initial: KimiConfig = {
      providers: {
        // Not an Open Platform id — `astron` is one, and that path is read-only
        // (see the next test). This is a hand-written record carrying the one
        // wire type the form has no field for.
        'corp-astron': {
          type: 'astron',
          apiKey: 'sk-astron',
          baseUrl: 'https://astron.example.com/v2',
        },
      },
      models: {
        'corp-astron/glm-5': { provider: 'corp-astron', model: 'glm-5', maxContextSize: 128000 },
      },
    };
    const rig = makeCommandRig(initial);
    const form = await openEditForm(rig);

    // Neither refused nor read-only: the form carries the stored type as an
    // extra candidate rather than collapsing the record onto one of its six.
    expect(form.disabled).toBe(false);
    expect(plain(form)).toContain('‹ astron ›');

    form.handleInput(TAB); // id -> type
    form.handleInput(RIGHT); // the extra entry sits last: astron -> kimi
    form.handleInput(LEFT); // and back
    for (let i = 0; i < 8; i++) form.handleInput(TAB); // type -> save
    form.handleInput(ENTER);

    await waitForPanel(rig, ProviderManagerComponent);
    expect(rig.readConfig().providers['corp-astron']?.type).toBe('astron');
    expect(setConfigPatch(rig.host)?.providers?.['corp-astron']).toEqual(
      initial.providers['corp-astron'],
    );
    expect(rig.host.showError).not.toHaveBeenCalled();
  });

  it('opens an Open Platform provider read-only rather than refusing it', async () => {
    const initial: KimiConfig = {
      providers: {
        'moonshot-cn': {
          type: 'kimi',
          apiKey: 'sk-platform',
          baseUrl: 'https://api.moonshot.cn/v1',
        },
      },
      models: {
        'moonshot-cn/kimi-k3': {
          provider: 'moonshot-cn',
          model: 'kimi-k3',
          maxContextSize: 262144,
        },
      },
    };
    const rig = makeCommandRig(initial);
    const form = await openEditForm(rig);

    // Its account belongs to `/login`, and nothing in the record says so — an
    // Open Platform provider is written with `oauth` dropped, which is why the
    // id is the only signal. Renaming it would orphan the credential and let
    // the next refresh re-add `moonshot-cn` beside the renamed copy.
    expect(form.disabled).toBe(true);
    expect(plain(form)).toContain(t('tui.dialogs.providerForm.managedReadonly'));

    for (const key of [TAB, ENTER, 'D', CTRL_R]) form.handleInput(key);
    form.handleInput(ESC);
    await waitForPanel(rig, ProviderManagerComponent);
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.host.harness.removeProvider).not.toHaveBeenCalled();
    expect(rig.readConfig()).toEqual(initial);
  });

  it('lands a replacing edit as one section replace when the host can', async () => {
    const rig = makeCommandRig(EDIT_CONFIG, { atomicSections: true });
    const form = await openEditForm(rig);

    replaceText(form, 'demo', 'demo2');
    for (let i = 0; i < 9; i++) form.handleInput(TAB); // id → save
    form.handleInput(ENTER);

    await waitForPanel(rig, ProviderManagerComponent);
    // One write, and neither half of the two-call pairing is used — which is the
    // whole point: nothing can exit between a removal and its replacement.
    expect(rig.host.harness.replaceConfigSections).toHaveBeenCalledTimes(1);
    expect(rig.host.harness.removeProvider).not.toHaveBeenCalled();
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();

    const written = rig.readConfig();
    expect(Object.keys(written.providers)).toEqual(['demo2']);
    expect(Object.keys(written.models ?? {})).toEqual(['demo2/gpt-4.1']);
    expect(written.defaultModel).toBe('demo2/gpt-4.1');
    // The sections carry whole records, not a delta: the merge path cannot
    // delete a key, and this path must not need it to.
    const sections = rig.host.harness.replaceConfigSections.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(sections)).toEqual([
      'providers',
      'models',
      'defaultModel',
      'defaultProvider',
    ]);
    expect(sections['defaultProvider']).toBeUndefined();
  });

  it('leaves the same config whichever write shape the host takes', async () => {
    const runEdit = async (atomicSections: boolean): Promise<KimiConfig> => {
      const rig = makeCommandRig(EDIT_CONFIG, { atomicSections });
      const form = await openEditForm(rig);
      replaceText(form, 'demo', 'demo2');
      for (let i = 0; i < 9; i++) form.handleInput(TAB); // id → save
      form.handleInput(ENTER);
      await waitForPanel(rig, ProviderManagerComponent);
      return rig.readConfig();
    };

    // The split exists to change how many writes land, never what the file ends
    // up saying. Both shapes are run on the same starting config so any drift
    // between them fails here rather than on a user's machine.
    expect(await runEdit(true)).toEqual(await runEdit(false));
  });
});
