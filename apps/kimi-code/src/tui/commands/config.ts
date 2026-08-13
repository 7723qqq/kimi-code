import {
  effectiveModelAlias,
  PRIMARY_SUBAGENT_MODEL_CHOICE,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type ExperimentalFeatureState,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import type { Locale } from '#/i18n';
import { getLocale, setLocale, t } from '#/i18n';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';

import {
  AstronSettingsComponent,
  ASTRON_DEFAULT_SETTINGS,
  type AstronSettings,
} from '../components/dialogs/astron-settings';
import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { LocaleSelectorComponent } from '../components/dialogs/locale-selector';
import { modelDisplayName, segmentsFor } from '../components/dialogs/model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import {
  SettingsSelectorComponent,
  type SettingsSelection,
} from '../components/dialogs/settings-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { DEFAULT_TUI_CONFIG, saveTuiConfig, type TuiConfig } from '../config';
import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';
import { showUsage } from './info';
import { promptApiKey } from './prompts';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some((entry) => entry.kind === 'user' && entry.bullet !== '');
}

export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  return {
    theme: host.state.appState.theme,
    locale: host.state.appState.locale as Locale,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
    astron: DEFAULT_TUI_CONFIG.astron,
  };
}

export function effectiveModelForHost(host: SlashCommandHost, model: ModelAlias): ModelAlias {
  const providerType = host.state.appState.availableProviders[model.provider]?.type;
  // Flat models (no named provider, e.g. inline base_url served by a v2
  // backend) have no provider entry to look up; their own protocol declaration
  // plays the provider-identity role, mirroring the resolver.
  return effectiveModelAlias(model, providerType ?? model.protocol);
}

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice(t('tui.statusMessages.planCleared'));
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(t('tui.messages.configUnknownPlanSubcommand', { subcmd }));
    return;
  }

  // The session may already be in the requested mode (e.g. it was created
  // with config.defaultPlanMode applied), and re-entering plan mode throws.
  if (host.state.appState.planMode === enabled) {
    host.showNotice(`Plan mode is already ${enabled ? 'on' : 'off'}`);
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(
  host: SlashCommandHost,
  session: Session,
  enabled: boolean,
): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        t('tui.statusMessages.planModeOn'),
        plan?.path !== undefined
          ? t('tui.messages.configPlanPath', { path: plan.path })
          : undefined,
      );
      return;
    }
    host.showNotice(t('tui.statusMessages.planModeOff'));
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('tui.statusMessages.failedToSetPlanMode', { msg }));
  }
}

export async function handleYoloCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined && !host.engineV2) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
  // v2 session-less: the chosen mode is recorded in appState and passed to the
  // lazy-created session; apply the runtime permission only when one exists.

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'yolo') {
      host.showNotice(t('tui.statusMessages.yoloModeAlreadyOn'));
      return;
    }
    await session?.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice(t('tui.statusMessages.yoloModeOn'), t('tui.statusMessages.yoloModeOnSub'));
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'yolo') {
      host.showNotice(t('tui.statusMessages.yoloModeAlreadyOff'));
      return;
    }
    await session?.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('tui.statusMessages.yoloModeOff'));
    return;
  }

  // toggle
  if (currentMode === 'yolo') {
    await session?.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('tui.statusMessages.yoloModeOff'));
  } else {
    await session?.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice(t('tui.statusMessages.yoloModeOn'), t('tui.statusMessages.yoloModeOnSub'));
  }
}

export async function handleAutoCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined && !host.engineV2) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
  // v2 session-less: the chosen mode is recorded in appState and passed to the
  // lazy-created session; apply the runtime permission only when one exists.

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'auto') {
      host.showNotice(t('tui.statusMessages.autoModeAlreadyOn'));
      return;
    }
    await session?.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice(t('tui.statusMessages.autoModeOn'), t('tui.statusMessages.autoModeOnSub'));
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'auto') {
      host.showNotice(t('tui.statusMessages.autoModeAlreadyOff'));
      return;
    }
    await session?.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('tui.statusMessages.autoModeOff'));
    return;
  }

  // toggle
  if (currentMode === 'auto') {
    await session?.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice(t('tui.statusMessages.autoModeOff'));
  } else {
    await session?.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice(t('tui.statusMessages.autoModeOn'), t('tui.statusMessages.autoModeOnSub'));
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
  const customInstruction = args.trim() || undefined;
  await session.compact({ instruction: customInstruction });
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(t('tui.statusMessages.unknownTheme', { theme }));
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(t('tui.messages.configUnknownModelAlias', { alias }));
    return;
  }
  showModelPicker(host, alias);
}

export async function handleSecondaryModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  // The pool reserves `primary` as the symbolic "caller's own model" choice —
  // a user alias with that name can never be the subagent default.
  delete models[PRIMARY_SUBAGENT_MODEL_CHOICE];
  if (alias === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    host.showError(
      `"${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved by the subagent model pool (it always binds the caller's own model) — rename the [models] alias to use it here.`,
    );
    return;
  }
  if (Object.keys(models).length === 0) {
    host.showNotice(
      t('tui.statusMessages.noModelsConfigured'),
      t('tui.statusMessages.noModelsConfiguredSub'),
    );
    return;
  }
  if (alias.length > 0 && models[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  const secondary = (await host.harness.getConfig()).secondaryModel;
  // The v2 engine honors a lone legacy `model` key as the fallback pool
  // default — reflect it as the picker's current value.
  const current = secondary?.defaultModel ?? secondary?.model ?? '';
  showSecondaryModelPicker(host, models, current, alias.length > 0 ? alias : undefined);
}

export async function handleEffortCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError(t('tui.statusMessages.noModelSelected'));
    return;
  }
  const effective = effectiveModelForHost(host, model);
  const segments = segmentsFor(effective);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const providerType = host.state.appState.availableProviders[effective.provider]?.type;
    const protocol = effective.protocol ?? providerType;
    if (protocol !== 'anthropic') {
      host.showError(
        t('tui.messages.configUnsupportedEffort', { arg, alias, segments: segments.join(', ') }),
      );
      return;
    }
    const knownEfforts =
      effective.supportEfforts?.join(', ') ?? t('tui.messages.configNoneDeclared');
    host.showStatus(t('tui.messages.configUnknownEffort', { arg, alias, knownEfforts }), 'warning');
  }
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  const alias = host.state.appState.model;
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host)
        ? t('tui.messages.configEffortCachedWarning')
        : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  try {
    const result = await withTimeout(
      host.authFlow.refreshOAuthProviderModels(),
      MODEL_PICKER_REFRESH_TIMEOUT_MS,
    );
    if (result === undefined) return;
    for (const f of result.failed) {
      host.showStatus(
        t('tui.messages.configSkippedRefreshing', { provider: f.provider, reason: f.reason }),
        'warning',
      );
    }
  } catch (error) {
    host.showStatus(
      t('tui.messages.configSkippedRefreshingModels', { error: formatErrorMessage(error) }),
      'warning',
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(void 0);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(
      t('tui.messages.configEditorUnchanged', {
        value: value.length > 0 ? value : t('tui.messages.configEditorAutoDetect'),
      }),
    );
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      editorCommand,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configEditorSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? t('tui.messages.configEditorSet', { value })
      : t('tui.messages.configEditorAutoSet'),
  );
}

/**
 * The models a picker may offer: the user's configured aliases with
 * host-effective provider resolution applied, minus the synthesized
 * `__secondary__` derived entry — a runtime artifact of the v1 engine's
 * `[secondary_model]` recipe that must never be selectable as a model.
 */
function pickerModelsForHost(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels)
      .filter(([alias]) => alias !== SECONDARY_DERIVED_MODEL_ALIAS)
      .map(([alias, model]) => [alias, effectiveModelForHost(host, model)]),
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const models = pickerModelsForHost(host);
  const entries = Object.entries(models);
  if (entries.length === 0) {
    host.showNotice(
      t('tui.statusMessages.noModelsConfigured'),
      t('tui.statusMessages.noModelsConfiguredSub'),
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingEffort: host.state.appState.thinkingEffort,
      warning: hasConversationHistory(host)
        ? t('tui.messages.configModelCachedWarning')
        : undefined,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, true);
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  let session = host.session;
  if (session === undefined && host.engineV2) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // switch lands on the new session instead of being overwritten by its
    // assembly.
    await host.waitForLazyCreation();
    session = host.session;
  }
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError(t('tui.messages.configCannotSwitchWhileStreaming'));
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  let effectiveAlias = alias;
  let effectiveEffort = effort;

  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
      const status = await session.getStatus();
      effectiveAlias = status.model ?? alias;
      effectiveEffort = status.thinkingEffort;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('tui.statusMessages.switchModelFailed', { msg }));
    return;
  }

  if (session === undefined) {
    effectiveAlias = host.state.appState.model;
    effectiveEffort = host.state.appState.thinkingEffort;
  }
  const effectiveModelChanged = effectiveAlias !== prevModel;
  const effectiveEffortChanged = effectiveEffort !== prevEffort;
  const displayName = modelDisplayName(
    effectiveAlias,
    host.state.appState.availableModels[effectiveAlias],
  );
  host.setAppState({ model: effectiveAlias, thinkingEffort: effectiveEffort });
  if (session === undefined && runtimeChanged) {
    if (effectiveModelChanged) {
      host.track('model_switch', { model: effectiveAlias });
    }
    if (effectiveEffortChanged) {
      host.track('thinking_toggle', {
        enabled: effectiveEffort !== 'off',
        effort: effectiveEffort,
        from: prevEffort,
      });
    }
  }

  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(
        host,
        effectiveAlias,
        effectiveEffort,
        effectiveEffortChanged,
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(t('tui.messages.configModelSwitchedSaveFailed', { name: displayName, msg }));
      return;
    }
  }

  let status: string;
  if (effectiveModelChanged) {
    status = persist
      ? t('tui.messages.configModelSwitched', { name: displayName, effort: effectiveEffort })
      : t('tui.messages.configModelSwitchedSession', {
          name: displayName,
          effort: effectiveEffort,
        });
  } else if (effectiveEffortChanged) {
    status = persist
      ? t('tui.messages.configThinkingSet', { effort: effectiveEffort })
      : t('tui.messages.configThinkingSetSession', { effort: effectiveEffort });
  } else if (persist && persisted) {
    status = t('tui.messages.configModelSavedDefault', {
      name: displayName,
      effort: effectiveEffort,
    });
  } else {
    status = t('tui.messages.configModelAlreadyUsing', {
      name: displayName,
      effort: effectiveEffort,
    });
  }
  host.showStatus(status, 'success');
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  effortChanged: boolean,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const model = host.state.appState.availableModels[alias];
  const full = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model).supportEfforts,
  );
  // Re-confirming the effort shown when the picker opened is not an explicit
  // choice — persist the model but leave the stored effort preference alone.
  const patch = effortChanged ? full : { enabled: full.enabled };
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    (!effortChanged || config.thinking?.effort === patch.effort)
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Secondary model (`/secondary-model`) — persists `[secondary_model] default_model`
// ---------------------------------------------------------------------------

function showSecondaryModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  selectedValue?: string,
): void {
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      selectedValue,
      currentThinkingEffort: 'off',
      // Subagent pool bindings carry no explicit thinking level, so the picker
      // hides the Thinking footer instead of offering a no-op choice.
      thinkingControl: false,
      title: ' Select a secondary model (subagents)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void performSecondaryModelSave(host, alias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/**
 * Persists `[secondary_model] default_model`. When a
 * `[secondary_model.models]` pool exists and does not list the alias yet, the
 * alias is added with an empty description — the engine requires the default
 * to be a pool key. Without a pool the default alone forms an implicit
 * single-entry pool, so nothing else is written. No live-apply step: the
 * engine resolves the pool per spawn, so the next subagent dispatch picks the
 * new value up on its own.
 */
async function performSecondaryModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    const config = await host.harness.getConfig({ reload: true });
    const existing = config.secondaryModel?.models;
    const patch: { defaultModel: string; models?: Record<string, string> } = {
      defaultModel: alias,
    };
    if (existing !== undefined) {
      patch.models = { ...existing, [alias]: existing[alias] ?? '' };
    }
    await host.harness.setConfig({ secondaryModel: patch });
  } catch (error) {
    host.showError(`Failed to save secondary model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Secondary model set to ${displayName}. Newly spawned subagents will use it by default.`,
    'success',
  );
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(t('tui.messages.configThemeUnchanged', { theme }));
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(t('tui.messages.configThemeLoadFailed', { theme }), 'error');
      return;
    }
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      theme,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configThemeSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  const resolved =
    theme === 'auto' ? (currentTheme.palette === lightColors ? 'light' : 'dark') : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail =
    theme === 'auto' ? t('tui.messages.configThemeTracking', { resolved: resolved ?? '' }) : '';
  host.showStatus(t('tui.messages.configThemeSet', { theme, detail }));
}

export function showLocalePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new LocaleSelectorComponent({
      currentValue: getLocale(),
      onSelect: (locale) => {
        host.restoreEditor();
        void applyLocaleChoice(host, locale);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyLocaleChoice(host: SlashCommandHost, locale: Locale): Promise<void> {
  if (locale === host.state.appState.locale) {
    host.showStatus(t('tui.messages.configLanguageUnchanged', { locale }));
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      locale,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configLanguageSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  setLocale(locale);
  host.setAppState({ locale });
  host.showStatus(t('tui.messages.configLanguageSet', { locale }));
}

export function showPermissionPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      onSelect: (value) => {
        host.restoreEditor();
        void applyPermissionChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export function showUpdatePreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor();
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function showExperimentsPanel(host: SlashCommandHost): Promise<void> {
  let features: readonly ExperimentalFeatureState[];
  try {
    features = await host.harness.getExperimentalFeatures();
  } catch (error) {
    host.showError(
      t('tui.statusMessages.loadExperimentsFailed', { error: formatErrorMessage(error) }),
    );
    return;
  }
  mountExperimentsPanel(host, features);
}

export async function showAstronSettingsPanel(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const astron = config.providers?.['astron'];
  if (astron === undefined) {
    host.showStatus(t('tui.dialogs.astronSettings.notConfigured'));
    return;
  }
  const initial: AstronSettings = {
    stream: typeof astron.stream === 'boolean' ? astron.stream : ASTRON_DEFAULT_SETTINGS.stream,
    temperature:
      typeof astron.temperature === 'number'
        ? astron.temperature
        : ASTRON_DEFAULT_SETTINGS.temperature,
    maxTokens:
      typeof astron.maxTokens === 'number' ? astron.maxTokens : ASTRON_DEFAULT_SETTINGS.maxTokens,
    searchDisable:
      typeof astron.searchDisable === 'boolean'
        ? astron.searchDisable
        : ASTRON_DEFAULT_SETTINGS.searchDisable,
  };
  host.mountEditorReplacement(
    new AstronSettingsComponent({
      initial,
      onSave: (settings) => {
        void saveAstronSettings(host, settings);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function saveAstronSettings(host: SlashCommandHost, settings: AstronSettings): Promise<void> {
  // Pre-save validation: bounds-check the values the TUI component already
  // guards against, so a stale/invalid value never reaches the config layer.
  if (settings.temperature < 0 || settings.temperature > 2) {
    host.showStatus(t('tui.dialogs.astronSettings.temperatureOutOfRange'));
    return;
  }
  if (settings.maxTokens < 1) {
    host.showStatus(t('tui.dialogs.astronSettings.maxTokensOutOfRange'));
    return;
  }
  try {
    const config = await host.harness.getConfig();
    const astron = config.providers?.['astron'];
    if (astron === undefined) {
      host.showStatus(t('tui.dialogs.astronSettings.notConfigured'));
      return;
    }
    config.providers['astron'] = {
      ...astron,
      stream: settings.stream,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      searchDisable: settings.searchDisable,
    };
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      thinking: config.thinking,
    });
    host.showStatus(t('tui.dialogs.astronSettings.saved'));
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus(t('tui.messages.configNoExperimentalChanges'), 'textMuted');
    return;
  }

  const experimental: Record<string, boolean> = {};
  for (const change of changes) {
    experimental[change.id] = change.enabled;
  }

  try {
    await host.harness.setConfig({ experimental });
    const features = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(features);
    host.refreshSlashCommandAutocomplete();
    host.restoreEditor();
    if (host.session !== undefined) {
      await host.session.reloadSession();
      await host.reloadCurrentSessionView(
        host.session,
        t('tui.statusMessages.experimentalUpdatedSessionReloaded'),
      );
    } else {
      host.showStatus(t('tui.statusMessages.experimentalUpdated'), 'success');
    }
    host.track('experimental_features_apply', { changed: changes.length });
  } catch (error) {
    host.showError(
      t('tui.statusMessages.updateExperimentsFailed', { error: formatErrorMessage(error) }),
    );
  }
}

function mountExperimentsPanel(
  host: SlashCommandHost,
  features: readonly ExperimentalFeatureState[],
): void {
  host.mountEditorReplacement(
    new ExperimentsSelectorComponent({
      features,
      onApply: (changes) => {
        void applyExperimentalFeatureChanges(host, changes);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade'
    >;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'upgrade'>): void;
  showStatus(msg: string, color?: string): void;
  track: SlashCommandHost['track'];
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(
      t('tui.messages.configAutoUpdateAlready', {
        state: autoInstall
          ? t('tui.messages.configAutoUpdateEnabled')
          : t('tui.messages.configAutoUpdateDisabled'),
      }),
    );
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configAutoUpdateSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ upgrade });
  host.track('upgrade_preference_changed', { auto_install: autoInstall });
  host.showStatus(
    t('tui.messages.configAutoUpdateSet', {
      state: autoInstall
        ? t('tui.messages.configAutoUpdateEnabled')
        : t('tui.messages.configAutoUpdateDisabled'),
    }),
  );
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(t('tui.messages.configPermissionUnchanged', { mode }));
    return;
  }

  try {
    if (host.session !== undefined) {
      await host.session.setPermission(mode);
    } else if (!host.engineV2) {
      host.showError(getNoActiveSessionMessage());
      return;
    }
    // v2 session-less: the chosen mode is recorded in appState and passed to
    // the lazy-created session.
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('tui.statusMessages.setPermissionFailed', { msg }));
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(t('tui.messages.configPermissionMode', { mode }));
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  host.restoreEditor();
  switch (value) {
    case 'model':
      showModelPicker(host);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'theme':
      showThemePicker(host);
      return;
    case 'editor':
      showEditorPicker(host);
      return;
    case 'experiments':
      void showExperimentsPanel(host);
      return;
    case 'language':
      showLocalePicker(host);
      return;
    case 'upgrade':
      showUpdatePreferencePicker(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'github_token':
      void handleGitHubTokenInput(host);
      return;
    case 'astron':
      void showAstronSettingsPanel(host);
      return;
  }
}

async function handleGitHubTokenInput(host: SlashCommandHost): Promise<void> {
  const token = await promptApiKey(host, 'GitHub', [t('tui.messages.configGithubTokenInput')]);
  if (token === undefined) return;
  try {
    await host.harness.setConfig({ experimental: { github_token: token } });
    host.showStatus(t('tui.messages.configGithubTokenSaved'), 'success');
  } catch (error) {
    host.showError(
      t('tui.messages.configGithubTokenSaveFailed', { error: formatErrorMessage(error) }),
    );
  }
}
