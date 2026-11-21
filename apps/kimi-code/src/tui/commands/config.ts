import {
  ErrorCodes,
  isKimiError,
  type ExperimentalFeatureState,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import { isKittyProtocolActive, TuiAltScreen } from '@moonshot-ai/pi-tui';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { MermaidPreferenceSelectorComponent } from '../components/dialogs/mermaid-preference-selector';
import { modelDisplayName, segmentsFor } from '../components/dialogs/model-selector';
import { FollowUpBehaviorSelectorComponent } from '../components/dialogs/follow-up-behavior-selector';
import { ModelSwitchConfirmDialogComponent } from '../components/dialogs/model-switch-confirm-dialog';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import {
  CopyOnSelectSelectorComponent,
  SettingsSelectorComponent,
  ThinkingDisplaySelectorComponent,
  ToolCallDensitySelectorComponent,
  type SettingsSelection,
} from '../components/dialogs/settings-selector';
import { SurveyPreferenceSelectorComponent } from '../components/dialogs/survey-preference-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { TuiModeSelectorComponent } from '../components/dialogs/tui-mode-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import {
  DEFAULT_MARKDOWN_CONFIG,
  DEFAULT_TUI_CONFIG,
  resolveFollowUpBehavior,
  resolveTuiMode,
  saveTuiConfig,
  type FollowUpBehavior,
  type MarkdownConfig,
  type TranscriptConfig,
  type TuiConfig,
  type TuiMode,
} from '../config';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import {
  matchModelSwitchRule,
  needsModelSwitchConfirmConfigRefresh,
  peekModelSwitchConfirmConfig,
  refreshModelSwitchConfirmConfig,
  resolveModelSwitchHint,
  resolveModelSwitchWarning,
  type ModelSwitchAction,
  type ModelSwitchRule,
} from '#/utils/model-switch-confirm-config';
import {
  matchEffortSwitchRule,
  needsEffortSwitchConfigRefresh,
  peekEffortSwitchConfig,
  refreshEffortSwitchConfig,
  type EffortSwitchRule,
} from '#/utils/effort-switch-config';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { MAIN_AGENT_ID, NO_ACTIVE_SESSION_MESSAGE, TUI_MODE_RESTART_NOTICE } from '../constant/kimi-tui';
import { DOCK_PREVIEW_ROWS } from '../constant/rendering';
import type { QueuedModelSwitch } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { setMarkdownMermaidMode, type MermaidRenderMode } from '../utils/markdown-options';
import {
  effectiveModelForHost,
  hasConversationHistory,
  MODEL_SWITCH_CACHE_WARNING,
  performModelSwitch,
  type ModelSwitchPersistence,
} from '../utils/model-switch';
import { PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_DISPLAY_NAMES } from '../utils/permission-mode';
import { showUsage } from './info';
import { setExperimentalFeatures } from './experimental-flags';
import type { SlashCommandHost } from './dispatch';
import { t } from '#/i18n';

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

const MODEL_SWITCH_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

const EFFORT_SWITCH_CACHE_WARNING =
  t('tui.messages.configEffortCachedWarning');

export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  return {
    theme: host.state.appState.theme,
    tuiMode: host.state.appState.tuiMode,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    copyOnSelect:
      host.state.appState.copyOnSelect ?? DEFAULT_TUI_CONFIG.copyOnSelect,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    autoSessionTitle: host.state.appState.autoSessionTitle ?? DEFAULT_TUI_CONFIG.autoSessionTitle,
    followUpBehavior: host.state.appState.followUpBehavior,
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
    markdown: host.state.appState.markdown ?? DEFAULT_MARKDOWN_CONFIG,
    transcript: host.state.appState.transcript,
  };
}

export function applyTranscriptPresentation(host: SlashCommandHost): void {
  host.state.transcriptContainer.setPresentationOptions({
    ...host.state.appState.transcript,
    fullscreen: host.state.ui.mode === 'fullscreen',
  });
}

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
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
    host.showError(t('tui.messages.configUnknownPlanSubcommand', { subcmd: subcmd }));
    return;
  }

  if (host.state.appState.planMode === enabled) {
    host.showNotice(
      t(enabled ? 'tui.statusMessages.planModeAlreadyOn' : 'tui.statusMessages.planModeAlreadyOff'),
    );
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, enabled: boolean): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        t('tui.statusMessages.planModeOn'),
        plan?.path !== undefined ? t('tui.messages.configPlanPath', { path: plan.path ?? '' }) : undefined,
      );
      return;
    }
    host.showNotice(t('tui.statusMessages.planModeOff'));
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('tui.statusMessages.failedToSetPlanMode', { msg: msg }));
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  try {
    await session.compact({ instruction: customInstruction });
  } catch (error) {
    const message = formatErrorMessage(error);
    host.setAppState({ isCompacting: false });
    host.failSessionRequest(message);
  }
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
      host.showError(`Unknown theme: ${theme}`);
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length === 0) {
    await showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(t('tui.messages.configUnknownModelAlias', { alias: alias }));
    return;
  }
  await showModelPicker(host, alias);
}

export async function handleSecondaryModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  if (Object.keys(models).length === 0) {
    host.showNotice(
      t('tui.statusMessages.noModelsConfigured'),
      t('tui.statusMessages.noModelsConfiguredSub'),
    );
    return;
  }
  if (alias.length > 0 && models[alias] === undefined) {
    host.showError(t('tui.messages.configUnknownModelAlias', { alias: alias }));
    return;
  }
  const secondary = (await host.harness.getConfig()).secondaryModel;
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
    if (model.provider === DEFAULT_OAUTH_PROVIDER_NAME) await ensureEffortSwitchConfig(host);
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const providerType = host.state.appState.availableProviders[effective.provider]?.type;
    const protocol = effective.protocol ?? providerType;
    if (protocol !== 'anthropic') {
      host.showError(
        `Unsupported thinking effort "${arg}" for ${alias}. Available: ${segments.join(', ')}`,
      );
      return;
    }
    const knownEfforts = effective.supportEfforts?.join(t('tui.migration.listSeparator')) ?? t('tui.messages.configNoneDeclared');
    host.showStatus(
      `Thinking effort "${arg}" is not listed for ${alias} (known: ${knownEfforts}). Sending "${arg}" unchanged; the configured provider will validate it.`,
      'warning',
    );
  }
  await confirmThenPerformEffortSwitch(host, arg, 'model');
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host) ? EFFORT_SWITCH_CACHE_WARNING : undefined,
      descriptions: model.provider === DEFAULT_OAUTH_PROVIDER_NAME ? effortDescriptions() : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void confirmThenPerformEffortSwitch(host, effort, 'model');
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void confirmThenPerformEffortSwitch(host, effort, 'session');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function confirmThenPerformEffortSwitch(
  host: SlashCommandHost,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (
    model?.provider !== DEFAULT_OAUTH_PROVIDER_NAME ||
    thinking === host.state.appState.thinkingEffort
  ) {
    await performModelSwitch(host, alias, thinking, persist);
    return;
  }
  await ensureEffortSwitchConfig(host);
  if (matchedEffortSwitchRule(host, thinking) === undefined) {
    await performModelSwitch(host, alias, thinking, persist);
    return;
  }
  confirmThenPerformModelSwitch(host, alias, thinking, persist);
}

function effortDescriptions(): Record<string, string> | undefined {
  const config = peekEffortSwitchConfig();
  if (config?.descriptions?.enable !== true) return undefined;
  const descriptions: Record<string, string> = {};
  for (const [effort, localized] of Object.entries(config.descriptions.items ?? {})) {
    if (localized.en !== undefined) descriptions[effort] = localized.en;
  }
  return descriptions;
}

async function ensureEffortSwitchConfig(host: SlashCommandHost): Promise<void> {
  if (!needsEffortSwitchConfigRefresh()) return;
  try {
    await refreshEffortSwitchConfig({ accessToken: await host.harness.auth.getCachedAccessToken() });
  } catch {}
}

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
      host.showStatus(t('tui.commands.config.skippedRefresh', { p1: f.provider, p2: f.reason }), 'warning');
    }
  } catch (error) {
    host.showStatus(t('tui.messages.configSkippedRefreshingModels', { error: formatErrorMessage(error) }), 'warning');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
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
    host.showStatus(`Editor unchanged: ${value.length > 0 ? value : t('tui.messages.configEditorAutoDetect')}`);
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
      ? `Editor set to "${value}".`
      : t('tui.messages.configEditorAutoSet'),
  );
}

function pickerModelsForHost(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels).map(([alias, model]) => [
      alias,
      effectiveModelForHost(host, model),
    ]),
  );
}

export async function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): Promise<void> {
  if (needsModelSwitchConfirmConfigRefresh() || needsEffortSwitchConfigRefresh()) {
    try {
      const accessToken = await host.harness.auth.getCachedAccessToken();
      const readiness: Promise<unknown>[] = [];
      if (needsModelSwitchConfirmConfigRefresh()) {
        readiness.push(refreshModelSwitchConfirmConfig({ accessToken }));
      }
      if (needsEffortSwitchConfigRefresh()) readiness.push(refreshEffortSwitchConfig({ accessToken }));
      await Promise.all(readiness);
    } catch {}
  }
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
      warning: hasConversationHistory(host) ? MODEL_SWITCH_CACHE_WARNING : undefined,
      effortDescriptions: effortDescriptions(),
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        confirmThenPerformModelSwitch(host, alias, thinking, 'model');
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        confirmThenPerformModelSwitch(host, alias, thinking, 'session');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export function confirmThenPerformModelSwitch(
  host: SlashCommandHost,
  alias: string,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): void {
  const effortOnly = alias === host.state.appState.model && thinking !== host.state.appState.thinkingEffort;
  const rule = effortOnly ? matchedEffortSwitchRule(host, thinking) : matchedModelSwitchRule(host, alias);
  if (rule === undefined) {
    void performModelSwitch(host, alias, thinking, persist);
    return;
  }
  const availableModels = host.state.appState.availableModels;
  const fromModel = effortOnly
    ? host.state.appState.thinkingEffort
    : modelDisplayName(host.state.appState.model, availableModels[host.state.appState.model]);
  const toModel = effortOnly ? thinking : modelDisplayName(alias, availableModels[alias]);
  const sessionType = hasConversationHistory(host) ? 'old' : 'new';
  const dismiss = (): void => {
    if (host.state.activeDialog !== 'model-switch-confirm') return;
    host.state.activeDialog = null;
    host.restoreEditor();
  };
  let settled = false;
  host.mountEditorReplacement(
    new ModelSwitchConfirmDialogComponent({
      fromModel,
      toModel,
      sessionType,
      kind: effortOnly ? 'effort' : 'model',
      hint: resolveModelSwitchHint(rule),
      warning: resolveModelSwitchWarning(rule),
      onSelect: (action) => {
        if (settled) return;
        settled = true;
        dismiss();
        void runModelSwitchAction(host, action, alias, thinking, persist);
      },
      onCancel: () => {
        if (settled) return;
        settled = true;
        dismiss();
      },
    }),
  );
  host.state.activeDialog = 'model-switch-confirm';
}

function matchedEffortSwitchRule(host: SlashCommandHost, thinking: ThinkingEffort): EffortSwitchRule | undefined {
  const previous = host.state.appState.thinkingEffort;
  const model = host.state.appState.availableModels[host.state.appState.model];
  if (model?.provider !== DEFAULT_OAUTH_PROVIDER_NAME) return undefined;
  if (thinking === previous) return undefined;
  return matchEffortSwitchRule(
    peekEffortSwitchConfig(),
    previous,
    thinking,
    hasConversationHistory(host) ? 'old' : 'new',
  );
}

export function matchedModelSwitchRule(host: SlashCommandHost, alias: string): ModelSwitchRule | undefined {
  const prevAlias = host.state.appState.model;
  if (alias === prevAlias) return undefined;
  const fromModelId = host.state.appState.availableModels[prevAlias]?.model;
  const toModelId = host.state.appState.availableModels[alias]?.model;
  if (fromModelId === undefined || toModelId === undefined) return undefined;
  return matchModelSwitchRule(
    peekModelSwitchConfirmConfig(),
    fromModelId,
    toModelId,
    hasConversationHistory(host) ? 'old' : 'new',
  );
}

export async function compactForModelSwitch(
  host: SlashCommandHost,
  session: Session,
): Promise<boolean> {
  type CompactionSettle = 'completed' | 'cancelled' | 'failed' | 'timeout';
  let settle: (outcome: CompactionSettle) => void = () => undefined;
  const settled = new Promise<CompactionSettle>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = session.onEvent((event) => {
    if (event.agentId !== MAIN_AGENT_ID) return;
    if (event.type === 'compaction.completed') settle('completed');
    else if (event.type === 'compaction.cancelled') settle('cancelled');
    else if (event.type === 'error' && event.code === ErrorCodes.COMPACTION_FAILED) {
      settle('failed');
    }
  });
  const timer = setTimeout(() => {
    settle('timeout');
  }, MODEL_SWITCH_COMPACT_TIMEOUT_MS);
  try {
    await session.compact({});
    const outcome = await settled;
    if (outcome === 'completed' && host.session === session) return true;
    if (outcome === 'completed') {
      host.showNotice(t('tui.statusMessages.modelSwitchAbortedSessionChanged'));
    } else if (outcome === 'timeout') {
      host.showError(t('tui.statusMessages.modelSwitchCompactTimedOut'));
    } else if (outcome === 'cancelled') {
      host.showNotice(t('tui.statusMessages.modelSwitchCompactionCancelled'));
    } else {
      host.showNotice(t('tui.statusMessages.modelSwitchAbortedModelUnchanged'));
    }
    return false;
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.COMPACTION_UNABLE) {
      host.showError(
        "Couldn't compact while the agent is still running — model unchanged. Pause the goal or switch with Continue as-is.",
      );
    } else {
      host.showError(t('tui.statusMessages.modelSwitchCompactFailed', { error: formatErrorMessage(error) }));
    }
    return false;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

async function runModelSwitchAction(
  host: SlashCommandHost,
  action: ModelSwitchAction,
  alias: string,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<void> {
  const busy = host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting;
  switch (action) {
    case 'cancel':
      return;
    case 'continue':
      await performModelSwitch(host, alias, thinking, persist);
      return;
    case 'compact':
      if (busy) {
        host.enqueueModelSwitch(alias, thinking, persist);
        return;
      }
      await runModelSwitchWithQueueHeld(host, () =>
        compactThenPerformModelSwitch(host, alias, thinking, persist),
      );
      return;
  }
}

export async function runQueuedModelSwitch(
  host: SlashCommandHost,
  item: QueuedModelSwitch,
): Promise<void> {
  await runModelSwitchWithQueueHeld(host, async () => {
    if (item.queuedAfterCompactionSerial === host.completedCompactionSerial) {
      await compactThenPerformModelSwitch(host, item.alias, item.thinking, item.persist);
      return;
    }
    host.showNotice(t('tui.commands.config.skippedCompaction'));
    await performModelSwitch(host, item.alias, item.thinking, item.persist, {
      appliesNextTurn: false,
    });
  });
}

async function compactThenPerformModelSwitch(
  host: SlashCommandHost,
  alias: string,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<void> {
  if (host.session !== undefined && !(await compactForModelSwitch(host, host.session))) return;
  await performModelSwitch(host, alias, thinking, persist, { appliesNextTurn: false });
}

async function runModelSwitchWithQueueHeld(
  host: SlashCommandHost,
  action: () => Promise<unknown>,
): Promise<void> {
  const session = host.session;
  host.state.queuedMessageDispatchPending = true;
  host.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  try {
    await action();
  } finally {
    host.state.queuedMessageDispatchPending = false;
    if (
      (session === undefined || host.session === session) &&
      !host.streamingUI.hasActiveTurn() &&
      host.state.appState.streamingPhase !== 'shell' &&
      !host.state.appState.isCompacting
    ) {
      host.resetLivePane();
      host.setAppState({ streamingPhase: 'idle' });
      host.drainQueueIfIdle();
    }
  }
}


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
      thinkingControl: false,
      title: t('tui.dialogs.modelSelector.secondaryTitle'),
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
    host.showError(t('tui.messages.configSecondaryModelSaveFailed', { error: formatErrorMessage(error) }));
    return;
  }
  host.showStatus(
    t('tui.messages.configSecondaryModelSet', { model: displayName }),
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
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(`Theme "${theme}" could not be loaded.`, 'error');
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

  const resolved = theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail = theme === 'auto' ? t('tui.messages.configThemeTracking', { resolved: resolved ?? '' }) : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost, initialMode?: PermissionMode): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      initialValue: initialMode,
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
    host.showError(t('tui.statusMessages.loadExperimentsFailed', { error: formatErrorMessage(error) }));
    return;
  }
  mountExperimentsPanel(host, features);
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus(
      t('tui.messages.configNoExperimentalChanges'),
      'textMuted',
    );
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
    if (host.session !== undefined && changes.some((change) => change.id !== 'notify_user')) {
      const reloadedSession = await host.harness.reloadSession({ id: host.session.id });
      await host.reloadCurrentSessionView(
        reloadedSession,
        t('tui.statusMessages.experimentalUpdatedSessionReloaded'),
      );
    } else {
      host.showStatus(t('tui.statusMessages.experimentalUpdated'), 'success');
    }
    if (
      host.session !== undefined &&
      changes.some((change) => change.id === 'notify_user' && change.enabled)
    ) {
      host.showNotice(
        t('tui.messages.experimentalNotifyUserNewSession'),
      );
    }
    if (changes.some((change) => change.id === 'tower')) {
      host.showNotice(t('tui.messages.experimentalTowerRestart'));
    }
    host.track('experimental_features_apply', {
      changed: changes.length,
      flags: features
        .filter((feature) => feature.enabled)
        .map((feature) => feature.id)
        .toSorted()
        .join(','),
    });
  } catch (error) {
    host.showError(t('tui.statusMessages.updateExperimentsFailed', { error: formatErrorMessage(error) }));
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
    host.showStatus(t('tui.messages.configAutoUpdateAlready', { state: autoInstall ? t('tui.messages.configAutoUpdateEnabled') : t('tui.messages.configAutoUpdateDisabled') }));
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
  host.showStatus(t('tui.messages.configAutoUpdateSet', { state: autoInstall ? t('tui.messages.configAutoUpdateEnabled') : t('tui.messages.configAutoUpdateDisabled') }));
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(t('tui.statusMessages.permissionModeUnchanged', { mode: PERMISSION_MODE_DISPLAY_NAMES[mode] }));
    return;
  }

  try {
    if (host.session !== undefined) {
      await host.session.setPermission(mode);
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(t('tui.commands.config.permissionModeFailed', { p1: msg }));
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}`);
  if (mode !== 'manual') {
    host.showStatus(PERMISSION_MODE_DESCRIPTIONS[mode], 'warning');
  }
}

export function showSurveyPreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SurveyPreferenceSelectorComponent({
      currentValue: host.state.appState.disableFeedbackSurvey !== true,
      onSelect: (value) => {
        host.restoreEditor();
        void applySurveyPreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type SurveyPreferenceHost = {
  readonly state: {
    readonly appState: Pick<SlashCommandHost['state']['appState'], 'disableFeedbackSurvey'>;
  };
  readonly harness: {
    setConfig(patch: { disableFeedbackSurvey: boolean }): Promise<unknown>;
  };
  setAppState(
    patch: Pick<SlashCommandHost['state']['appState'], 'disableFeedbackSurvey'>,
  ): void;
  showStatus(msg: string, color?: string): void;
};

export async function applySurveyPreferenceChoice(
  host: SurveyPreferenceHost,
  enabled: boolean,
): Promise<void> {
  const disableFeedbackSurvey = !enabled;
  if (disableFeedbackSurvey === (host.state.appState.disableFeedbackSurvey === true)) {
    host.showStatus(t('tui.commands.config.feedbackSurveyAlready', { state: enabled ? t('common.enabled') : t('common.disabled') }));
    return;
  }

  try {
    await host.harness.setConfig({ disableFeedbackSurvey });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configSurveySaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  host.setAppState({ disableFeedbackSurvey });
  host.showStatus(t('tui.commands.config.feedbackSurveySet', { state: enabled ? t('common.enabled') : t('common.disabled') }));
}

export function showMermaidPreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new MermaidPreferenceSelectorComponent({
      currentValue: host.state.appState.markdown?.mermaid !== 'off',
      onSelect: (value) => {
        host.restoreEditor();
        void applyMermaidPreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type MermaidPreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade' | 'markdown'
    >;
    readonly transcriptContainer: { invalidate(): void };
    readonly ui: { requestRender(force?: boolean): void };
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'markdown'>): void;
  showStatus(msg: string, color?: string): void;
};

export async function applyMermaidPreferenceChoice(
  host: MermaidPreferenceHost,
  enabled: boolean,
): Promise<void> {
  const mermaid: MermaidRenderMode = enabled ? 'final' : 'off';
  if (mermaid === (host.state.appState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid)) {
    host.showStatus(t('tui.commands.config.mermaidAlready', { state: enabled ? t('common.enabled') : t('common.disabled') }));
    return;
  }

  const markdown: MarkdownConfig = { mermaid };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      markdown,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configMermaidSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }

  setMarkdownMermaidMode(mermaid);
  host.setAppState({ markdown });
  host.state.transcriptContainer.invalidate();
  host.state.ui.requestRender(true);
  host.showStatus(t('tui.commands.config.mermaidSet', { state: enabled ? t('common.enabled') : t('common.disabled') }));
}

function showCopyOnSelectPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new CopyOnSelectSelectorComponent({
      currentValue: host.state.appState.copyOnSelect !== false,
      onSelect: (enabled) => {
        host.restoreEditor();
        void applyCopyOnSelectChoice(host, enabled);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function applyCopyOnSelectChoice(
  host: Pick<SlashCommandHost, 'state' | 'setAppState' | 'showStatus'>,
  enabled: boolean,
): Promise<void> {
  if (enabled === (host.state.appState.copyOnSelect !== false)) {
    host.showStatus(t('tui.commands.config.copyOnSelectAlready', { state: enabled ? t('common.enabled') : t('common.disabled') }));
    return;
  }

  try {
    await saveTuiConfig({ ...currentTuiConfig(host), copyOnSelect: enabled });
  } catch (error) {
    host.showStatus(t('tui.messages.configCopyOnSelectSaveFailed', { error: formatErrorMessage(error) }), 'error');
    return;
  }

  host.setAppState({ copyOnSelect: enabled });
  if (host.state.ui instanceof TuiAltScreen) host.state.ui.setCopyOnSelect(enabled);
  host.showStatus(t('tui.commands.config.copyOnSelectSet', { state: enabled ? t('common.enabled') : t('common.disabled') }));
}

function showToolCallDensityPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ToolCallDensitySelectorComponent({
      current: host.state.appState.transcript,
      layout: host.state.dockContainer === undefined ? undefined : { maxBodyRows: DOCK_PREVIEW_ROWS },
      onSelect: (toolCallDensity) => {
        host.restoreEditor();
        void applyTranscriptConfigChoice(host, {
          ...host.state.appState.transcript,
          toolCallDensity,
        });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showThinkingDisplayPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThinkingDisplaySelectorComponent({
      current: host.state.appState.transcript,
      layout: host.state.dockContainer === undefined ? undefined : { maxBodyRows: DOCK_PREVIEW_ROWS },
      onSelect: (thinking) => {
        host.restoreEditor();
        void applyTranscriptConfigChoice(host, {
          ...host.state.appState.transcript,
          thinking,
        });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function applyTranscriptConfigChoice(
  host: SlashCommandHost,
  transcript: TranscriptConfig,
): Promise<void> {
  const current = host.state.appState.transcript;
  if (
    transcript.toolCallDensity === current.toolCallDensity &&
    transcript.thinking === current.thinking
  ) {
    host.showStatus(t('tui.messages.configTranscriptUnchanged'));
    return;
  }
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      transcript,
    });
  } catch (error) {
    host.showStatus(
      t('tui.messages.configTranscriptSaveFailed', { error: formatErrorMessage(error) }),
      'error',
    );
    return;
  }
  host.setAppState({ transcript });
  applyTranscriptPresentation(host);
  host.track('transcript_display_settings', {
    tool_call_density: transcript.toolCallDensity,
    thinking: transcript.thinking,
    source: 'settings',
  });
  host.showStatus(t('tui.messages.configTranscriptUpdated'), 'success');
}

export function showTuiModePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new TuiModeSelectorComponent({
      currentValue: host.state.appState.tuiMode ?? host.state.ui.mode,
      onSelect: (value) => {
        host.restoreEditor();
        void applyTuiModeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type TuiModeHost = {
  readonly state: {
    readonly appState: Pick<SlashCommandHost['state']['appState'], 'tuiMode'>;
    readonly ui: Pick<SlashCommandHost['state']['ui'], 'mode'>;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'tuiMode'>): void;
  showStatus(msg: string, color?: string): void;
  showNotice(msg: string): void;
  track?: SlashCommandHost['track'];
};

export async function applyTuiModeChoice(host: TuiModeHost, tuiMode: TuiMode): Promise<void> {
  const resolved = resolveTuiMode(tuiMode);
  if (tuiMode === host.state.appState.tuiMode) {
    host.showStatus(t('tui.commands.config.tuiModeAlready', { p1: tuiMode }));
  } else {
    try {
      await saveTuiConfig({
        ...currentTuiConfig(host as unknown as SlashCommandHost),
        tuiMode,
      });
    } catch (error) {
      host.showStatus(t('tui.messages.configTuiModeSaveFailed', { error: formatErrorMessage(error) }), 'error');
      return;
    }

    host.setAppState({ tuiMode });
    host.track?.('tui_mode_switch', { tui_mode: tuiMode });
    host.showStatus(t('tui.commands.config.tuiModeSet', { p1: tuiMode }), 'success');
  }
  if (resolved.mode !== tuiMode) {
    host.showNotice(
      resolved.overriddenByEnv
        ? t('tui.messages.configTuiModeEnvOverrideNotice')
        : t('tui.messages.configTuiModeFallbackNotice'),
    );
    return;
  }
  if (resolved.mode !== host.state.ui.mode) {
    host.showNotice(TUI_MODE_RESTART_NOTICE);
  }
}

function showFollowUpBehaviorPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new FollowUpBehaviorSelectorComponent({
      currentValue: resolveFollowUpBehavior(host.state.appState.followUpBehavior),
      ctrlEnterRecognized: isKittyProtocolActive(),
      onSelect: (value) => {
        host.restoreEditor();
        void applyFollowUpBehaviorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type FollowUpBehaviorHost = {
  readonly state: {
    readonly appState: Pick<SlashCommandHost['state']['appState'], 'followUpBehavior'>;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'followUpBehavior'>): void;
  showStatus(msg: string, color?: string): void;
};

export async function applyFollowUpBehaviorChoice(
  host: FollowUpBehaviorHost,
  followUpBehavior: FollowUpBehavior,
): Promise<void> {
  if (followUpBehavior === host.state.appState.followUpBehavior) {
    host.showStatus(t('tui.messages.configFollowUpBehaviorAlready', { value: followUpBehavior }));
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      followUpBehavior,
    });
  } catch (error) {
    host.showStatus(t('tui.messages.configFollowUpBehaviorSaveFailed', { error: formatErrorMessage(error) }), 'error');
    return;
  }

  host.setAppState({ followUpBehavior });
  host.showStatus(t('tui.messages.configFollowUpBehaviorSet', { value: followUpBehavior }), 'success');
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      fullscreen: host.state.ui.mode === 'fullscreen',
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
    case 'model': void showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'tuiMode': showTuiModePicker(host); return;
    case 'toolCallDensity': showToolCallDensityPicker(host); return;
    case 'thinking': showThinkingDisplayPicker(host); return;
    case 'copyOnSelect': showCopyOnSelectPicker(host); return;
    case 'mermaid': showMermaidPreferencePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'followUpBehavior': showFollowUpBehaviorPicker(host); return;
    case 'survey': showSurveyPreferencePicker(host); return;
    case 'experiments': void showExperimentsPanel(host); return;
    case 'upgrade': showUpdatePreferencePicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
