/**
 * TUI2 KimiTUI — the interactive shell host.
 *
 * Mirrors `tui/kimi-tui.ts` with the pi-tui `TUIState` swapped for the
 * response store (`Tui2Store`). The class keeps the same public surface
 * (KimiTUI / KimiTUIOptions / KimiTUIStartupInput) and all the session /
 * input / host logic; rendering is driven by the opentui reconciler from
 * store state instead of imperative Container mounting.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import { effectiveModelAlias, log } from '@moonshot-ai/kimi-code-sdk';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  KimiHarness,
  PermissionMode,
  PluginCommandDef,
  PromptPart,
  Session,
  SkillSummary,
  ThinkingEffort,
  TokenUsage,
  WorkspaceTrustInfo,
} from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import { resolve } from 'pathe';

import { deleteAllKittyImages, getCapabilities } from '../utils/terminal-image';

import { BannerProvider } from '../banner/banner-provider';
import { readBannerDisplayState, writeBannerDisplayState } from '../banner/state';
import { runMigrationFlow } from '../commands/migration-screen';

import {
  createMsys2PromptDeps,
  installMsys2,
  markPrompted,
  setUserShellPath,
  shouldPromptMsys2,
} from '#/cli/msys2-prompt';
import type { CLIOptions } from '#/cli/options';
import type { Locale } from '#/i18n';
import { getLocale, setLocale, t } from '#/i18n';
import type { MigrationScreenResult } from '#/migration/index';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { quoteShellArg } from '#/utils/shell-quote';
import { startupTrace } from '#/utils/startup-trace';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import {
  getBuiltinSlashCommands,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
  showUsage,
  sortSlashCommands,
  type KimiSlashCommand,
  type SkillListSession,
} from '../commands';
import * as slashCommands from '../commands/dispatch';
import type { SlashCommandHost } from '../commands/dispatch';
import {
  currentTuiConfig,
  handleGitHubTokenInput,
  showAstronSettingsPanel,
  showExperimentsPanel,
  showModelPicker,
} from '../commands/config';
import {
  handlePluginMcpSelection,
  renderPluginInfo,
  resolvePluginConfirm,
  showPluginMcpPicker,
} from '../commands/plugins';
import { setDeviceCodeCard } from '../components/chrome/device-code-box';
import { pickRandomWorkingTip } from '../components/chrome/working-tips';
import { defaultThinkingEffortFor } from '../components/dialogs/model-selector';
import type { Msys2PromptChoice } from '../components/dialogs/msys2-prompt';
import type { SessionRow } from '../components/dialogs/session-picker';
import type { TrustPromptChoice } from '../components/dialogs/trust-prompt';
import { saveTuiConfig, type TuiConfig } from '../config';
import {
  getLlmNotSetMessage,
  getNoActiveSessionMessage,
  MAIN_AGENT_ID,
  PRODUCT_NAME,
  SESSION_LIST_PAGE_SIZE,
  SESSIONLESS_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { MAX_TERMINAL_TITLE_LENGTH } from '../constant/terminal';
import type {
  DialogResult as DialogResultLike,
  GoalQueueEditResult,
  GoalQueueManagerAction,
  PluginAction,
} from '../dispatch';
import { installRainbowDance } from '../easter-eggs/dance';
import { createEventBus, type Tui2EventBus } from '../event';
import { ApprovalController } from '../reverse-rpc/approval/controller';
import { adaptPanelResponse } from '../reverse-rpc/approval/adapter';
import { createApprovalRequestHandler } from '../reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from '../reverse-rpc/index';
import { QuestionController } from '../reverse-rpc/question/controller';
import { createQuestionAskHandler } from '../reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from '../reverse-rpc/types';
import { createTui2Store, type Tui2Store } from '../state';
import type { TuiRuntimeState } from '../state';
import { currentTheme, getColorPalette, getBuiltInPalette, isBuiltInTheme } from '../theme';
import type { ColorToken, ResolvedTheme, ThemeName } from '../theme';
import {
  INITIAL_LIVE_PANE,
  type ActiveDialog,
  type AgentPaneItem,
  type AppState,
  type DiffReviewItem,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type SteerInputItem,
  type TasksBrowserState,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from '../types';
import { isDeadTerminalError } from '../utils/dead-terminal';
import { formatErrorMessage } from '../utils/event-payload';
import { pickForegroundTasks } from '../utils/foreground-task';
import { ImageAttachmentStore } from '../utils/image-attachment-store';
import { extractMediaAttachments, rewriteMediaPlaceholders } from '../utils/image-placeholder';
import type { ExtractionResult } from '../utils/image-placeholder';
import { extractInlineSkillActivations } from '../utils/inline-skill-tokens';
import { REPLAY_TURN_LIMIT } from '../utils/message-replay';
import { hasPatchChanges } from '../utils/object-patch';
import { sessionRowsForPicker } from '../utils/session-picker-rows';
import {
  accumulateStepCompleted,
  accumulateToolDuration,
  bumpTurnCount,
  createEmptySessionStats,
} from '../utils/session-stats';
import { formatBashOutputForDisplay } from '../utils/shell-output';
import { combineStartupNotice, isOAuthLoginRequiredError } from '../utils/startup';
import { formatStepRetryDetail, formatStepRetryLabel } from '../utils/step-retry';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import { detectTmuxKeyboardWarning } from '../utils/tmux-keyboard';
import { nextTranscriptId } from '../utils/transcript-id';
import {
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  groupTurns,
  turnsToTrim,
} from '../utils/transcript-window';
import { AuthFlowController } from './auth-flow';
import { createBtwPanelController, type BtwPanelController } from './btw-panel';
import { createCacheHintController, type CacheHintController } from './cache-hint-controller';
import {
  createClipboardImageHintController,
  type ClipboardImageHintController,
} from './clipboard-image-hint';
import { EditorKeyboardController } from './editor-keyboard';
import { SessionEventHandler } from './session-event-handler';
import { SessionReplayRenderer } from './session-replay';
import { StreamingUIController } from './streaming-ui';
import { TasksBrowserController } from './tasks-browser';
import { createWorkflowPanelController, type WorkflowPanelController } from './workflow-panel';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  /** Profile name resolved from cliOptions --agent/--agent-file (see resolveAgentProfileSelection). */
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly migrationPlan?: MigrationPlan | null;
  /** When true, run only the migration screen, then exit (the `kimi migrate` command). */
  readonly migrateOnly?: boolean;
  /** agent-core-v2 engine; enables the startup workspace-trust prompt. */
  readonly engineV2?: boolean;
}

type EffectiveActivityPaneMode =
  | AppState['streamingPhase']
  | 'idle'
  | 'session'
  | 'hidden'
  | 'tool';
type LoadingTipKind = 'moon' | 'composing';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

/**
 * Flatten steer items into the payload `session.steer` expects — see
 * `utils/steer-input.ts`.
 */
import { combineSteerInput } from '../utils/steer-input';
import { mainAgentPhaseLabel, subagentStatus } from '../utils/agent-pane-status';

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

/** Terminal output abstraction the tui2 shell writes through. */
export interface Tui2Terminal {
  write(data: string): void;
  setTitle(title: string): void;
  setProgress(active: boolean): void;
}

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  store: Tui2Store;
  /** Stable ui mode label for telemetry. The v1 host reads this from
   *  `state.ui.mode`; v2 has no pi-tui state and currently returns a
   *  constant — swap in the real store-derived value when the opentui
   *  shell exposes a fullscreen/inline mode. */
  get uiMode(): string {
    return 'opentui'
  }
  /** In-flight lazy session creation (v2 engine), shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<Session | undefined> | null = null;
  private readonly cacheHint: CacheHintController;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly KimiSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private fdPath: string | null = null;
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController: ClipboardImageHintController | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private backgroundRefreshPromise: Promise<void> | undefined;
  private readonly migrationPlan: MigrationPlan | null;
  private readonly migrateOnly: boolean;
  /** Whether the harness runs on the agent-core-v2 engine (lazy session creation). */
  readonly engineV2: boolean;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined =
    undefined;
  private lastHistoryContent: string | undefined;
  /** Skill names bundled into the prompt currently being dispatched; the
   *  activation cards they produce are grouped with that prompt. */
  private readonly pendingBundledSkillNames = new Set<string>();
  /** Transcript id of the user entry the current dispatch belongs to (bundled
   *  activation grouping reads it). */
  lastDispatchedUserEntryId: string | undefined;
  /** Last measured main-loop step usage — backs `estimateSwitchLossTokens`. */
  private switchLossBaseline: TokenUsage | undefined;
  /** Live `!` shell output entries, keyed by commandId. */
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; taskId?: string }
  >();
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly workflowPanelController: WorkflowPanelController;
  readonly editorKeyboard: EditorKeyboardController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  /** Resolver for the currently open trust prompt. */
  private trustPromptResolver: ((choice: TrustPromptChoice) => void) | undefined;
  /** Resolver for the currently open msys2 prompt. */
  private msys2PromptResolver: ((choice: Msys2PromptChoice) => void) | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  // -----------------------------------------------------------------------
  // Public actions invoked by `applyDialogResult` below. Each method
  // performs the smallest useful side effect on the host (config
  // mutation, session switch, controller dispatch). The "complete
  // side effect" is what the matching v1 controller does; for now
  // each method is the minimal viable stub that the dialog actually
  // *does* something — the rest is follow-up work.
  // -----------------------------------------------------------------------

  /** Switch to the chosen session (closes the picker, kicks the switch). */
  public async pickSession(sessionId: string): Promise<void> {
    // The picker list lives in `store.state.sessions` (fetched by
    // `fetchSessions`); there is no separate `sessionPicker` slice.
    const list = this.store.state.sessions;
    const target = list.find((s) => s.id === sessionId);
    if (target === undefined) return;
    const session = await this.harness.resumeSession({
      id: target.id,
      additionalDirs: [...this.store.state.additionalDirs],
      replayTurnLimit: REPLAY_TURN_LIMIT,
    });
    await this.switchToSession(session, `switched to ${target.id.slice(0, 12)}`);
  }

  /** Apply the chosen model alias + thinking effort to the live session. */
  public async pickModel(alias: string, effort: ThinkingEffort): Promise<void> {
    this.store.setState('modelSelector', {
      ...this.store.state.modelSelector,
      currentValue: alias,
      currentThinkingEffort: effort,
    });
    const session = this.session;
    if (session !== undefined) {
      try {
        await session.setModel(alias);
        await session.setThinking(effort);
        await this.syncRuntimeState(session);
      } catch {
        // Non-fatal: the store is updated; the next turn picks the new
        // model up even if the immediate call failed.
      }
    }
  }

  /** Apply a plugin-panel action with the full payload. */
  public async pluginAction(action: PluginAction): Promise<void> {
    switch (action.kind) {
      case 'toggle':
        this.store.setState('pluginsPanel', {
          ...this.store.state.pluginsPanel,
          installed: (this.store.state.pluginsPanel?.installed ?? []).map((p) =>
            p.id === action.id ? { ...p, enabled: action.enabled } : p,
          ),
        });
        return;
      case 'remove':
        this.store.setState('pluginsPanel', {
          ...this.store.state.pluginsPanel,
          installed: (this.store.state.pluginsPanel?.installed ?? []).filter(
            (p) => p.id !== action.id,
          ),
        });
        return;
      case 'reload':
        await this.refreshPluginCommands();
        return;
      case 'details':
        // Render the plugin's info into the transcript (the v1 flow uses
        // renderPluginInfo; the panel itself stays driven by the store).
        await renderPluginInfo(this as unknown as SlashCommandHost, action.id);
        return;
      case 'mcp':
        // Open the plugin-MCP sub-picker for the chosen plugin.
        await showPluginMcpPicker(this as unknown as SlashCommandHost, action.id);
        return;
    }
  }

  /** Apply the chosen locale. */
  public async pickLocale(locale: Locale): Promise<void> {
    this.store.setState('localeSelector', {
      ...this.store.state.localeSelector,
      currentValue: locale,
    });
    // Update the i18n module so subsequent `t(...)` calls render in the
    // chosen language. The store update alone wouldn't refresh UI copy.
    setLocale(locale);
  }

  /** Apply the chosen permission mode. */
  public async pickPermissionMode(mode: PermissionMode): Promise<void> {
    this.store.setState('permissionSelector', {
      ...this.store.state.permissionSelector,
      currentValue: mode,
    });
    // Push the change to the live session so subsequent tool calls honor
    // it. Without this the store would drift from the session state.
    const session = this.session;
    if (session !== undefined) {
      try {
        await session.setPermission(mode);
      } catch {
        // Session may not be ready yet (boot phase). The store change
        // is still applied; the session picks it up on the next turn.
      }
    }
  }

  /** Apply the chosen external-editor command. */
  public async pickEditorCommand(command: string): Promise<void> {
    this.store.setState('editorSelector', {
      ...this.store.state.editorSelector,
      currentValue: command,
    });
    // Persist through tui.toml so Ctrl-G uses the new command across
    // sessions / restarts.
    try {
      await saveTuiConfig({
        ...currentTuiConfig({ state: { appState: this.store.state } }),
        editorCommand: command.length > 0 ? command : null,
      });
    } catch {
      // Non-fatal: the in-memory config is updated regardless.
    }
  }

  /** Apply the chosen update-preference flag. */
  public async pickUpdatePreference(enabled: boolean): Promise<void> {
    this.store.setState('updatePreference', {
      ...this.store.state.updatePreference,
      currentValue: enabled,
    });
    try {
      await saveTuiConfig({
        ...currentTuiConfig({ state: { appState: this.store.state } }),
        upgrade: { autoInstall: enabled },
      });
    } catch {
      // Non-fatal.
    }
  }

  /** Apply the chosen settings sub-action. */
  public async pickSettingsAction(value: string): Promise<void> {
    // The settings selector is the entry point into the other pickers
    // (model / theme / editor / ...). When a non-meta value is picked
    // we open the matching sub-dialog.
    switch (value) {
      case 'model':
        // Full tabbed picker with the model list — the activeDialog
        // model-selector branch has no `models` data source.
        showModelPicker(this);
        return;
      case 'theme':
        this.store.setState('activeDialog', 'theme-selector');
        return;
      case 'editor':
        this.store.setState('activeDialog', 'editor-selector');
        return;
      case 'language':
        this.store.setState('activeDialog', 'locale-selector');
        return;
      case 'permission':
        this.store.setState('activeDialog', 'permission-selector');
        return;
      case 'experiments':
        // Mounted through the editor-replacement slot (same path as
        // /experiments); activeDialog has no experiments-selector branch.
        void showExperimentsPanel(this);
        return;
      case 'upgrade':
        this.store.setState('updatePreference', {
          ...this.store.state.updatePreference,
          currentValue: !(this.store.state.updatePreference?.currentValue ?? true),
        });
        return;
      case 'usage':
        void showUsage(this as unknown as SlashCommandHost);
        return;
      case 'github_token':
        // Same prompt as the v1 /settings flow: collect the token and
        // persist it to the config store.
        await handleGitHubTokenInput(this as unknown as SlashCommandHost);
        return;
      case 'astron':
        void showAstronSettingsPanel(this as unknown as SlashCommandHost);
        return;
    }
  }

  /** Apply the chosen goal-queue choice. */
  public async pickGoalStartChoice(choice: 'auto' | 'yolo' | 'manual' | 'cancel'): Promise<void> {
    const { resolveGoalStartPermissionChoice } = await import('../commands/goal');
    await resolveGoalStartPermissionChoice(
      this as unknown as Parameters<typeof resolveGoalStartPermissionChoice>[0],
      choice,
    );
  }

  /** Apply a goal-queue action (move/delete/edit). Move/delete refresh
   *  the stored list and keep the manager open; edit opens the edit
   *  dialog. */
  public async pickGoalQueueAction(action: GoalQueueManagerAction): Promise<void> {
    const { handleGoalQueueManagerAction } = await import('../commands/goal');
    const snapshot = await handleGoalQueueManagerAction(
      this as unknown as Parameters<typeof handleGoalQueueManagerAction>[0],
      action,
    );
    if (snapshot !== undefined) {
      this.store.setState('goalQueueManager', {
        ...this.store.state.goalQueueManager,
        goals: snapshot.goals,
      });
    }
  }

  /** Apply the edit-dialog result (save/cancel) and return to the manager. */
  public async pickGoalQueueEditResult(result: GoalQueueEditResult): Promise<void> {
    const { handleGoalQueueEditResult } = await import('../commands/goal');
    await handleGoalQueueEditResult(
      this as unknown as Parameters<typeof handleGoalQueueEditResult>[0],
      result,
    );
  }

  /** Apply the chosen undo-selector choice (restore target). */
  public async pickUndoChoice(count: number, input: string): Promise<void> {
    // The full payload (count + input text) is needed to actually restore
    // the editor buffer and trim the transcript. We delegate to the
    // existing `resolveUndoSelectorChoice` in `commands/undo.ts` so the
    // session/undo-history + store-trim logic runs unchanged.
    const { resolveUndoSelectorChoice } = await import('../commands/undo');
    resolveUndoSelectorChoice(this as unknown as Parameters<typeof resolveUndoSelectorChoice>[0], {
      count,
      input,
    });
  }

  /** Apply the chosen effort to the live session. */
  public async pickEffort(effort: ThinkingEffort): Promise<void> {
    this.store.setState('effortSelector', {
      ...this.store.state.effortSelector,
      currentValue: effort,
    });
    const session = this.session;
    if (session !== undefined) {
      try {
        await session.setThinking(effort);
        await this.syncRuntimeState(session);
      } catch {
        // Store state is the source of truth; session picks it up next turn.
      }
    }
  }

  /** Apply the chosen startup permission. */
  public async pickStartPermission(choice: 'auto' | 'yolo' | 'manual' | 'cancel'): Promise<void> {
    this.store.setState('startPermission', {
      ...this.store.state.startPermission,
      chosen: choice,
    });
  }

  /** Apply the chosen swarm-startup permission. */
  public async pickSwarmStartPermission(choice: 'auto' | 'yolo' | 'manual'): Promise<void> {
    const { resolveSwarmStartPermissionChoice } = await import('../commands/swarm');
    await resolveSwarmStartPermissionChoice(
      this as unknown as Parameters<typeof resolveSwarmStartPermissionChoice>[0],
      choice,
    );
  }

  /**
   * Apply a dialog result emitted by the MainShell's `DialogDispatch`.
   * Routes the result to the matching public action and dismisses the
   * active dialog. Public so the run.tsx adapter can wire MainShell to
   * KimiTUI without leaking the host's internals.
   */
  public async applyDialogResult(result: DialogResultLike): Promise<void> {
    // Goal-queue actions, task-browser actions, the plugin MCP picker and
    // session-picker paging keep their dialog open (the host drives
    // dismissal); every other result dismisses the active dialog.
    const keepsOpen =
      result.kind === 'goal-queue-manager' ||
      result.kind === 'tasks-browser' ||
      result.kind === 'plugins-mcp' ||
      result.kind === 'session-picker-scope-toggle' ||
      result.kind === 'session-picker-load-more';
    if (!keepsOpen) {
      this.store.setState('activeDialog', null);
    }
    switch (result.kind) {
      case 'session-picker':
        await this.pickSession(result.sessionId);
        return;
      case 'session-picker-scope-toggle':
        await this.toggleSessionPickerScope(result.sessionId);
        return;
      case 'session-picker-load-more':
        await this.loadMoreSessions();
        return;
      case 'model-selector':
        await this.pickModel(result.alias, result.effort);
        return;
      case 'plugins-selector':
        await this.pluginAction(result.action);
        return;
      case 'theme-selector':
        await this.applyTheme(result.themeName as ThemeName);
        return;
      case 'locale-selector':
        await this.pickLocale(result.locale);
        return;
      case 'permission-selector':
        await this.pickPermissionMode(result.mode);
        return;
      case 'editor-selector':
        await this.pickEditorCommand(result.command);
        return;
      case 'update-preference':
        await this.pickUpdatePreference(result.enabled);
        return;
      case 'msys2-prompt':
        this.msys2PromptResolver?.(result.choice);
        this.msys2PromptResolver = undefined;
        return;
      case 'trust-prompt':
        this.trustPromptResolver?.(result.choice);
        this.trustPromptResolver = undefined;
        return;
      case 'settings-selector':
        await this.pickSettingsAction(result.value);
        return;
      case 'cache-hint':
        this.cacheHint.resolveDialog(result.action);
        return;
      case 'goal-queue-manager':
        await this.pickGoalQueueAction(result.action);
        return;
      case 'goal-queue-edit':
        await this.pickGoalQueueEditResult(result.result);
        return;
      case 'goal-start-permission-prompt':
        await this.pickGoalStartChoice(result.choice);
        return;
      case 'undo-selector':
        await this.pickUndoChoice(result.count, result.input);
        return;
      case 'effort-selector':
        await this.pickEffort(result.effort);
        return;
      case 'start-permission-prompt':
        await this.pickStartPermission(result.choice);
        return;
      case 'swarm-start-permission-prompt':
        await this.pickSwarmStartPermission(result.choice);
        return;
      case 'approval-panel':
        this.approvalController.respond(adaptPanelResponse(result.response));
        return;
      case 'question-dialog':
        this.questionController.respond({
          method: result.method,
          answers: [...result.answers],
        });
        return;
      case 'help':
      case 'which-key':
        // Display-only; close already happened above. Drop the help-panel
        // payload so a stale command list is not reused on the next open.
        if (result.kind === 'help') this.store.setState('helpPanel', undefined);
        return;
      case 'tasks-browser':
        switch (result.action) {
          case 'select':
            if (result.taskId !== undefined) this.tasksBrowserController.select(result.taskId);
            return;
          case 'toggle-filter':
            this.tasksBrowserController.toggleFilter();
            return;
          case 'refresh':
            this.tasksBrowserController.refresh();
            return;
          case 'stop':
            if (result.taskId !== undefined) void this.tasksBrowserController.stop(result.taskId);
            return;
          case 'open-output':
            if (result.taskId !== undefined) void this.tasksBrowserController.openOutput(result.taskId);
            return;
          case 'close-viewer':
            this.tasksBrowserController.closeOutputViewer();
            return;
          case 'cancel':
            this.tasksBrowserController.close();
            return;
        }
        return;
      case 'plugins-confirm':
        resolvePluginConfirm(this, result.confirmed);
        return;
      case 'plugins-mcp':
        void handlePluginMcpSelection(this, result.selection);
        return;
    }
  }

  /** Dismiss the active dialog without applying a result. */
  public cancelDialog(): void {
    this.store.setState('activeDialog', null);
  }

  /** Terminal output sink (defaults to process.stdout). */
  readonly terminal: Tui2Terminal;
  /** Event bus over the current session (rebuilt on session switch). */
  eventBus: Tui2EventBus | undefined = undefined;

  /** Host-contract alias for `eventBus` (BtwPanelHost reads `bus`). */
  get bus(): Tui2EventBus | undefined {
    return this.eventBus;
  }

  /** Minimal shell-state adapter for the v1-shaped command host contract. */
  get state(): {
    appState: AppState;
    transcriptEntries: TranscriptEntry[];
    activeDialog: ActiveDialog | null;
    ui: { requestRender(): void };
  } {
    return {
      appState: this.store.state,
      transcriptEntries: this.store.state.transcript,
      activeDialog: this.store.state.activeDialog,
      ui: { requestRender: () => {} },
    };
  }

  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void {
    this.harness.track(event, properties);
  }

  /** Write bytes to the terminal (host contract for controllers). */
  write(data: string): void {
    this.terminal.write(data);
  }

  /** Release the terminal for the external editor (tui2: no-op, opentui owns it). */
  stopForExternalEditor(): void {}

  /** Restore the terminal after the external editor exits (tui2: no-op). */
  startAfterExternalEditor(): void {}

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput, terminal?: Tui2Terminal) {
    this.harness = harness;
    const startupPermission: PermissionMode = startupInput.cliOptions.auto
      ? 'auto'
      : startupInput.cliOptions.yolo
        ? 'yolo'
        : 'manual';
    const tuiOptions: KimiTUIOptions = {
      initialAppState: {
        model: '',
        workDir: startupInput.workDir,
        additionalDirs: [...(startupInput.additionalDirs ?? [])],
        sessionId: '',
        permissionMode: startupPermission,
        planMode: startupInput.cliOptions.plan,
        inputMode: 'prompt',
        swarmMode: false,
        thinkingEffort: 'off',
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        cacheReadTokens: 0,
        cacheMissTokens: 0,
        cacheOtherTokens: 0,
        tokenSpeed: 0,
        sessionStats: createEmptySessionStats(),
        outputTokens: 0,
        locale: getLocale(),
        isCompacting: false,
        isReplaying: false,
        streamingPhase: 'idle',
        streamingStartTime: 0,
        stepRetry: null,
        theme: startupInput.tuiConfig.theme,
        version: startupInput.version,
        editorCommand: startupInput.tuiConfig.editorCommand,
        disablePasteBurst: startupInput.tuiConfig.disablePasteBurst,
        renderLatex: startupInput.tuiConfig.renderLatex,
        cacheExpiryHint: startupInput.tuiConfig.cacheExpiryHint,
        notifications: startupInput.tuiConfig.notifications,
        upgrade: startupInput.tuiConfig.upgrade,
        statusLine: startupInput.tuiConfig.statusLine,
        availableModels: {},
        availableProviders: {},
        sessionTitle: null,
        goal: null,
        mcpServersSummary: null,
        banner: undefined,
      },
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        agentProfile: startupInput.agentProfile,
        agentFiles: startupInput.cliOptions.agentFiles,
        startupNotice: startupInput.startupNotice,
      },
    };
    this.options = tuiOptions;
    this.migrationPlan = startupInput.migrationPlan ?? null;
    this.migrateOnly = startupInput.migrateOnly ?? false;
    this.engineV2 = startupInput.engineV2 ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.terminal = terminal ?? {
      write: (data) => process.stdout.write(data),
      setTitle: (title) => process.stdout.write(`\u001B]0;${title}\u0007`),
      setProgress: () => {},
    };
    this.store = createTui2Store({
      workDir: startupInput.workDir,
      additionalDirs: startupInput.additionalDirs,
      permissionMode: startupPermission,
      planMode: startupInput.cliOptions.plan,
      locale: getLocale(),
      theme: startupInput.tuiConfig.theme,
      version: startupInput.version,
      editorCommand: startupInput.tuiConfig.editorCommand,
      disablePasteBurst: startupInput.tuiConfig.disablePasteBurst,
      renderLatex: startupInput.tuiConfig.renderLatex,
      cacheExpiryHint: startupInput.tuiConfig.cacheExpiryHint,
      notifications: startupInput.tuiConfig.notifications,
      upgrade: startupInput.tuiConfig.upgrade,
      statusLine: startupInput.tuiConfig.statusLine,
      agentProfile: startupInput.agentProfile,
      agentFiles: startupInput.cliOptions.agentFiles,
    });
    this.uninstallRainbowDance = installRainbowDance(() => {});

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = createBtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.workflowPanelController = createWorkflowPanelController(this.eventBus, this.store);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.cacheHint = createCacheHintController(this);
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(getBuiltinSlashCommands()).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  private setupAutocomplete(): void {
    // The tui2 editor component reads the slash-command catalog from the
    // store; the v1 FileMentionProvider (pi-tui editor) is not used here.
    this.store.setState('autocompleteProvider', this.getSlashCommands());
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      // v2 engine: skills live on the workspace handler, not the session, so
      // they are available before the first (lazy) session is created.
      if (this.engineV2) {
        try {
          const skills = await this.harness.listWorkspaceSkills(this.store.state.workDir);
          this.applySkillCommands(skills);
          return;
        } catch {
          return;
        }
      }
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    this.applySkillCommands(skills);
  }

  private applySkillCommands(skills: readonly SkillSummary[]): void {
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  async refreshPluginCommands(session?: Session): Promise<void> {
    if (session === undefined) {
      // v2 engine: the enabled plugin commands are an app-global live view,
      // available before the first (lazy) session is created.
      if (this.engineV2) {
        try {
          const defs = await this.harness.listPluginCommands();
          this.applyPluginCommands(defs);
          return;
        } catch {
          return;
        }
      }
      this.pluginCommands = [];
      this.pluginCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch {
      return;
    }
    this.applyPluginCommands(defs);
  }

  private applyPluginCommands(defs: readonly PluginCommandDef[]): void {
    const pluginSlashCommands = buildPluginSlashCommands(defs);
    this.pluginCommands = pluginSlashCommands.commands;
    this.pluginCommandMap.clear();
    for (const [commandName, body] of pluginSlashCommands.commandMap) {
      this.pluginCommandMap.set(commandName, body);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    startupTrace('tui:start');
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {
      // The workspace trust gate must run before anything else in startup —
      // including the migration branch: a workspace that needs migration is
      // not implicitly trusted, and later startup steps spawn child processes.
      startupTrace('trustPrompt:begin');
      const trustPromptStartedLoop = await this.maybeRunWorkspaceTrustPrompt();
      startupTrace('trustPrompt:end');

      // The one-time MSYS2 install gate (Windows only) runs after the trust
      // gate: it spawns winget, which must never run before trust is granted.
      startupTrace('msys2Prompt:begin');
      await this.maybeRunMsys2Prompt(trustPromptStartedLoop);
      startupTrace('msys2Prompt:end');

      if (this.migrationPlan !== null) {
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            const failed = migrationResult.decision === 'now' && migrationResult.migrated === false;
            this.disposeTerminalTracking();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          const shouldReplayHistory = await this.initMainTui();
          this.startBackgroundFdAutocomplete();
          await this.finishStartup(shouldReplayHistory);
        } catch (error) {
          this.disposeTerminalTracking();
          throw error;
        }
        return;
      }

      startupTrace('initMainTui:begin');
      const shouldReplayHistory = await this.initMainTui();
      startupTrace('initMainTui:end');
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace('finishStartup:begin');
        await this.finishStartup(shouldReplayHistory);
        startupTrace('finishStartup:end');
      } catch (error) {
        this.disposeTerminalTracking();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    if (this.store.state.version.length === 0) return;
    const provider = new BannerProvider(this.store.state.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load({ state: displayState, now });
    this.store.setState('banner', banner);
    if (banner === null || banner.display === 'always') return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // Best-effort: banner display state should never block startup.
    }
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.renderWelcome();
    return shouldReplayHistory;
  }

  /** Mount the welcome panel entry; idempotent across /clear and session
   *  switches (mirrors the v1 `renderWelcome`). */
  private renderWelcome(): void {
    if (this.store.state.transcript.some((entry) => entry.kind === 'welcome')) return;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'welcome',
      renderMode: 'plain',
      content: '',
    });
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = createClipboardImageHintController({
      store: this.store,
      onRawInput: () => () => {},
      getModelSupportsImage: () => this.supportsCurrentModelCapability('image_in'),
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    this.fdPath = detectFdPath();
    if (this.fdPath !== null) {
      this.setupAutocomplete();
      return;
    }

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(`${c.providerName} · +${String(c.added)} model${c.added > 1 ? 's' : ''}.`);
      }
      for (const f of result.failed) {
        this.showStatus(`Skipped refreshing ${f.provider}: ${f.reason}`, 'warning');
      }
    } catch {
      // Best-effort: startup must not crash on background refresh failures.
    }
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    // Config diagnostics (deprecated keys/env vars, invalid sections) in
    // warning yellow at boot.
    void this.showConfigWarningsIfAny();
    if (this.store.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      void this.showSessionWarnings(this.session);
    }
    if (shouldReplayHistory) {
      void this.cacheHint.maybeShowOnResume();
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.updateTerminalTitle();
    }
    void this.refreshSkillCommands(this.session);
    void this.refreshPluginCommands(this.session);
  }

  private async showSessionWarnings(session: Session): Promise<void> {
    try {
      const warnings = await session.getSessionWarnings();
      if (this.session !== session) return;
      for (const warning of warnings) {
        const severity = warning.severity === 'error' ? 'error' : 'warning';
        this.showStatus(`Warning: ${warning.message}`, severity);
      }
    } catch {
      // Best-effort: startup must not block on warning retrieval.
    }
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning');
  }

  private async init(): Promise<boolean> {
    setExperimentalFeatures(await this.harness.getExperimentalFeatures());
    await this.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.store.state;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: MutableCreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? 'auto' : startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
      // --agent/--agent-file bind the startup session only; sessions created
      // later in this process fall back to the default profile.
      agentProfile: startup.agentProfile,
      agentFiles: startup.agentFiles?.length ? [...startup.agentFiles] : undefined,
    };
    if (this.store.state.additionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [...this.store.state.additionalDirs];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.store.setState('startupState', 'picker');
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(
              t('tui.statusMessages.sessionNotFound', { sessionId: startup.sessionFlag }),
            );
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            process.stderr.write(
              `${currentTheme.hex('warning')}Session "${startup.sessionFlag}" was created under a different directory.\n` +
                `  cd "${target.workDir}" && kimi -r ${startup.sessionFlag}\n\n`,
            );
            throw new Error(
              `Session "${startup.sessionFlag}" was created under a different directory.`,
            );
          }
          session = await this.harness.resumeSession({
            id: startup.sessionFlag,
            additionalDirs: createSessionOptions.additionalDirs,
            replayTurnLimit: REPLAY_TURN_LIMIT,
          });
          shouldReplayHistory = true;
        } else {
          // Only the most recent session matters here — fetch a one-item page
          // instead of materializing the whole listing.
          const page = await this.harness.listSessionsPage({ workDir, limit: 1 });
          const target = page.items[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({
              id: target.id,
              additionalDirs: createSessionOptions.additionalDirs,
              replayTurnLimit: REPLAY_TURN_LIMIT,
            });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else if (this.engineV2) {
        // Lazy session creation (v2 engine): start session-less and create the
        // session on the first message.
        await this.hydrateLazyConfigDefaults();
        this.appendStartupNotice(SESSIONLESS_STARTUP_NOTICE);
      } else {
        session = await this.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (!this.engineV2 && session === undefined) {
      throw new Error(t('tui.statusMessages.noActiveSession'));
    }
    if (session !== undefined) {
      await this.setSession(session);
      await this.syncRuntimeState(session);
    }
    this.applyStartupPermissionAndPlanToAppState();
    this.store.setState('startupState', 'ready');
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    // Give the startup provider-model refresh a brief chance to finish before
    // the harness closes (and the process exits).
    if (this.backgroundRefreshPromise !== undefined) {
      await Promise.race([
        this.backgroundRefreshPromise,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1500)),
      ]);
    }
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down.
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.workflowPanelController.clear();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.editorKeyboard.dispose();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // Restore the terminal even if closing the session / harness throws.
    try {
      await this.closeSession('shutting down');
      await this.harness.close();
    } finally {
      this.sessionEventHandler.clearStepRetryAttemptTimer();
      this.uninstallRainbowDance();
      try {
        restoreTerminalModes();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    // Best-effort terminal restore: stop() may not have run (SIGHUP) or may
    // have thrown (SIGTERM cleanup failure), so recover raw mode / cursor /
    // bracketed paste before exiting instead of leaving the user's shell broken.
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this as unknown as SlashCommandHost, next ? 'on' : 'off');
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.updateEditorBorderHighlight();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.store.state.inputMode === 'bash';
    // In tui2 the `!` prefix stays in the editor buffer (the opentui input is
    // not directly editable programmatically without an input focus, unlike
    // v1's CustomEditor); strip it here so the command executes without the
    // mode marker, mirroring v1's "`!` is the prompt symbol, not part of the
    // command" contract.
    const command = wasBashMode && text.startsWith('!') ? text.slice(1) : text;
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.store.setState('inputMode', 'prompt');
      this.handleInputModeChange('prompt');
    }
    if (command.trim().length === 0) return;
    if (this.store.state.isReplaying) {
      this.showError(t('tui.statusMessages.cannotSendWhileReplaying'));
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode.
    const historyText = wasBashMode ? `!${command}` : command;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.store.state.streamingPhase !== 'idle') {
        this.enqueueMessage(command, undefined, 'bash');
        this.updateQueueDisplay();
        return;
      }
      void this.runShellCommandFromInput(command);
      return;
    }
    slashCommands.dispatchInput(this as unknown as SlashCommandHost, command);
  }

  /** Dispatch a slash command by name (used by leader-key chords). */
  runSlashCommand(name: string, args?: string): void {
    const input = args !== undefined && args.length > 0 ? `/${name} ${args}` : `/${name}`;
    slashCommands.dispatchInput(this as unknown as SlashCommandHost, input);
  }

  private async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.session;
    if (session === undefined) {
      if (!this.engineV2) {
        this.showError(t('tui.statusMessages.noActiveSessionShell'));
        return;
      }
      session = await this.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight; honor the busy gate here.
      if (this.store.state.streamingPhase !== 'idle') {
        this.enqueueMessage(command, undefined, 'bash');
        this.updateQueueDisplay();
        return;
      }
    }
    // Echo the command locally (bash-input) with a `$` prompt.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: `$ ${command}`,
      bullet: '',
      color: 'shellMode',
    });
    // Create the live output entry up front; mutated in place as output
    // streams in and on completion.
    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    };
    this.shellOutputStreams.set(commandId, { entry: outputEntry });
    this.store.patch('shellOutputs', {
      [commandId]: { content: '', finished: false },
    });
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: 'shell' });

    this.track('shell_command');

    void session.runShellCommand(command, { commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(commandId, stdout, stderr, isError, backgrounded);
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, '', message, true);
        this.showError(`Shell command failed: ${message}`);
      },
    );
  }

  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? '';
    if (text.length === 0) return;
    const current = this.store.state.shellOutputs[event.commandId];
    if (current === undefined) return;
    this.store.patch('shellOutputs', {
      [event.commandId]: { ...current, content: current.content + text },
    });
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    stream.taskId = event.taskId;
    const current = this.store.state.shellOutputs[event.commandId];
    if (current === undefined) return;
    this.store.patch('shellOutputs', {
      [event.commandId]: { ...current, taskId: event.taskId },
    });
  }

  cancelRunningShellCommand(): void {
    const session = this.session;
    if (session === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.showError(`Failed to cancel shell command: ${formatErrorMessage(error)}`);
      });
    }
  }

  private finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (backgrounded === true) {
      // The command was moved to the background; detachRunningShellCommand owns
      // the UI and the model notification.
      return;
    }
    const formatted = formatBashOutputForDisplay(stdout, stderr, isError);
    stream.entry.content = formatted.text;
    stream.entry.color = formatted.color;
    this.store.patch('shellOutputs', {
      [commandId]: { content: formatted.text, finished: true },
    });
    this.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: 'idle' });
      this.drainOneQueuedMessage();
    }
  }

  /** Send the oldest queued message (Ctrl+S). No-op when the queue is empty. */
  drainOneQueuedMessage(): void {
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    const session = this.session;
    if (session === undefined) return;
    if (item.mode === 'bash') {
      void this.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.updateQueueDisplay();
  }

  async sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.store.state.model.trim().length === 0) {
      this.showError(getLlmNotSetMessage());
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    try {
      // Pasted videos are copied into the cache and expand to a `file://`
      // `video_url` part; the engine resolves (uploads or degrades) them
      // inside the turn, so submission stays fully synchronous.
      //
      // A cache-hint-swallowed resend passes its pre-dialog extraction back
      // in: the image store may already be cleared (e.g. after "Start a new
      // session"), so re-extracting from the text would lose the media.
      extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
    } catch (error) {
      // A video cache copy failed (unwritable cache dir, vanished source…);
      // nothing was dispatched.
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    // Idle cache-hint interception sits before session creation; it is
    // synchronous unless a hint actually fires, keeping the send path
    // await-free up to sendMessage.
    if (this.cacheHint.maybeInterceptOnSubmit(text, extraction)) return;
    let session = this.session;
    if (session === undefined) {
      if (!this.engineV2) {
        this.showError(getLlmNotSetMessage());
        return;
      }
      session = await this.ensureSession();
      if (session === undefined) return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError(t('tui.statusMessages.modelNoImageInput'));
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError(t('tui.statusMessages.modelNoVideoInput'));
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities = this.store.state.availableModels[this.store.state.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.store.state.workDir);
      const entries = await loadInputHistory(file);
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    try {
      const file = getInputHistoryFile(this.store.state.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.store.state.queuedMessages.length === 0) return undefined;
    const last = this.store.state.queuedMessages.at(-1)!;
    this.store.setState('queuedMessages', this.store.state.queuedMessages.slice(0, -1));
    return last;
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  private enqueueMessage(
    text: string,
    options?: SendMessageOptions,
    mode?: 'prompt' | 'bash',
  ): void {
    this.store.setState('queuedMessages', [
      ...this.store.state.queuedMessages,
      {
        text,
        agentId: this.harness.interactiveAgentId,
        parts: options?.parts,
        imageAttachmentIds:
          options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
            ? options.imageAttachmentIds
            : undefined,
        videoAttachmentIds:
          options?.videoAttachmentIds !== undefined && options.videoAttachmentIds.length > 0
            ? options.videoAttachmentIds
            : undefined,
        mode,
      },
    ]);
    this.track('input_queue');
  }

  beginSessionRequest(): void {
    this.cacheHint.onTurnBegin();
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    // A queued slash-skill activation re-enters through the activation path,
    // not as a literal prompt (mirrors v1 `sendQueuedMessage`). Every manual
    // drain funnels here (Ctrl+S / shell-finish via drainOneQueuedMessage,
    // /init finalize); the event-driven drain routes identically inside
    // session-event-handler.
    if (item.skillName !== undefined) {
      this.sendSkillActivation(session, item.skillName, item.skillArgs ?? '');
      return;
    }
    if (item.mode === 'bash') {
      void this.runShellCommandFromInput(item.text);
      return;
    }
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts: item.parts,
        imageAttachmentIds: item.imageAttachmentIds,
      });
    });
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    const videoAttachmentIds =
      options?.videoAttachmentIds !== undefined && options.videoAttachmentIds.length > 0
        ? options.videoAttachmentIds
        : undefined;
    const userEntryId = nextTranscriptId();
    this.lastDispatchedUserEntryId = userEntryId;
    this.appendTranscriptEntry({
      id: userEntryId,
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
      videoAttachmentIds,
    });

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (this.store.state.goal?.status === 'active') {
      void session.steer(sdkInput).catch((error: unknown) => {
        const message = formatErrorMessage(error);
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(`Failed to steer: ${message}`);
      });
      return;
    }
    // Inline `/skill` mentions ride the prompt as bundled activations (v2
    // engine): validated up front and rendered ahead of the prompt in the
    // same turn, so the whole submission undoes as one anchor.
    const skills = this.engineV2
      ? extractInlineSkillActivations(input, this.skillCommandMap, { includeLeading: true })
      : [];
    for (const s of skills) this.pendingBundledSkillNames.add(s.skillName);
    void (
      skills.length > 0 && typeof session.promptWithSkills === 'function'
        ? session.promptWithSkills(
            sdkInput,
            skills.map((s) => ({ name: s.skillName })),
          )
        : session.prompt(sdkInput)
    ).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      for (const s of skills) this.pendingBundledSkillNames.delete(s.skillName);
      const userIndex = this.store.state.transcript.findIndex((e) => e.id === userEntryId);
      if (userIndex !== -1) {
        this.store.setState(
          'transcript',
          this.store.state.transcript.filter((e) => e.id !== userEntryId),
        );
      }
      this.failSessionRequest(`Failed to send: ${message}`);
    });
  }

  /** Whether `skillName` was bundled into the prompt currently dispatching. */
  hasPendingBundledSkill(skillName: string): boolean {
    return this.pendingBundledSkillNames.has(skillName);
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    // Args are a plain-text channel, so pasted media can't ride along as
    // inline parts. Skill args are XML-escaped on render, so rewrite
    // placeholders into escape-proof plain-text file references.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(skillArgs, this.imageStore, 'plain');
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session.activateSkill(skillName, rewrite.text).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Skill "${skillName}" failed: ${message}`);
    });
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    // Plugin command args are expanded verbatim (no XML escaping), so the
    // standard <image|video path> tag convention works.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, 'tag');
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activatePluginCommand(pluginId, commandName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(`Command "${pluginId}:${commandName}" failed: ${message}`);
      });
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.deferUserMessages ||
      this.store.state.streamingPhase !== 'idle' ||
      this.store.state.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    if (this.deferUserMessages || this.store.state.isCompacting) {
      for (const item of input) {
        this.enqueueMessage(item.text, item);
      }
      return;
    }
    if (this.store.state.streamingPhase === 'idle') {
      for (const item of input) {
        this.sendMessageInternal(session, item.text, item);
      }
      return;
    }

    for (const item of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: item.text,
        imageAttachmentIds:
          item.imageAttachmentIds !== undefined && item.imageAttachmentIds.length > 0
            ? item.imageAttachmentIds
            : undefined,
        videoAttachmentIds:
          item.videoAttachmentIds !== undefined && item.videoAttachmentIds.length > 0
            ? item.videoAttachmentIds
            : undefined,
      });
    }

    void session.steer(combineSteerInput(input)).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`Failed to steer: ${message}`);
    });
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.store.setState('startupState', 'ready');
  }

  clearQueuedMessages(): void {
    this.store.setState('queuedMessages', []);
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.store.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.store.state.queuedMessages;
    this.store.setState('queuedMessages', rest);
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.store.setState('transcript', [...this.store.state.transcript, entry]);
  }

  setExternalEditorRunning(running: boolean): void {
    this.store.setState('externalEditorRunning', running);
  }

  setTasksBrowser(value: TasksBrowserState | undefined): void {
    this.store.setState('tasksBrowser', value);
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.store.state.sessionId;
  }

  hasSessionContent(): boolean {
    return this.store.state.transcript.length > 0;
  }

  setExitOpenUrl(url: string): void {
    this.exitOpenUrl = url;
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.exitForegroundTask = task;
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.store.state, patch)) return;
    const additionalDirsChanged =
      'additionalDirs' in patch &&
      !sameStringArrays(this.store.state.additionalDirs, patch.additionalDirs ?? []);
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    this.store.setState(patch as Partial<TuiRuntimeState>);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.updateActivityPane();
    this.updateAgentPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (additionalDirsChanged) this.setupAutocomplete();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    this.store.patch('livePane', patch);
    this.updateActivityPane();
  }

  resetLivePane(): void {
    this.store.setState('livePane', { ...INITIAL_LIVE_PANE });
    this.updateActivityPane();
  }

  private syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.store.state.additionalDirs, additionalDirs)) return;
    this.setAppState({ additionalDirs: [...additionalDirs] });
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(getNoActiveSessionMessage());
    }
    return this.session;
  }

  /**
   * Seed appState with the config defaults the v2 engine would apply at
   * createSession time (model, permission, plan mode, thinking effort,
   * context cap), so the footer and the lazy create path reflect them while
   * no session exists.
   */
  async hydrateLazyConfigDefaults(): Promise<void> {
    const { startup } = this.options;
    const config = await this.harness.getConfig({ reload: true });
    const patch: Partial<AppState> = {};
    const startupModel = startup.model ?? config.defaultModel;
    if (startupModel !== undefined) {
      patch.model = startupModel;
      const selected = config.models?.[startupModel];
      if (selected?.maxContextSize !== undefined) {
        patch.maxContextTokens = selected.maxContextSize;
      }
    } else {
      // The default disappeared from config (edited externally): clear the
      // previously hydrated value instead of passing a stale explicit model
      // to the first lazy-created session.
      patch.model = '';
      patch.maxContextTokens = 0;
    }
    // CLI --auto/--yolo/--plan win over config defaults; the flags are
    // re-applied by applyStartupPermissionAndPlanToAppState at startup.
    if (!startup.auto && !startup.yolo) {
      // Reset to manual when the default was removed from config.
      patch.permissionMode = config.defaultPermissionMode ?? 'manual';
    }
    // Track the config default itself (vs an explicit CLI --plan) so the lazy
    // create path can tell which one would activate plan mode.
    patch.configDefaultPlanMode = config.defaultPlanMode === true;
    if (!startup.plan) {
      patch.planMode = config.defaultPlanMode === true;
    }
    const effort = thinkingEffortFromConfig(config.thinking);
    if (effort !== undefined) {
      patch.thinkingEffort = effort;
    } else if (startupModel !== undefined) {
      // No concrete effort configured: mirror the engine, which resolves the
      // model's default effort at createSession time.
      const raw = config.models?.[startupModel];
      if (raw !== undefined) {
        const providerType = config.providers?.[raw.provider]?.type;
        patch.thinkingEffort = defaultThinkingEffortFor(
          effectiveModelAlias(raw, providerType ?? raw.protocol),
        );
      }
    }
    if (startup.agentProfile !== undefined || startup.agentFiles !== undefined) {
      patch.agentProfile = startup.agentProfile;
      patch.agentFiles = startup.agentFiles?.length ? [...startup.agentFiles] : undefined;
    }
    this.setAppState(patch);
  }

  private async createSessionFromCurrentState(bindStartupAgent = false): Promise<Session> {
    // Background warm-up of the cache-hint config on every new session.
    this.cacheHint.refreshConfigInBackground();
    const model = this.store.state.model.trim();
    if (model.length === 0) {
      throw new Error(getLlmNotSetMessage());
    }
    // With an active session, carry the live plan state. Session-less (lazy
    // creation / `/new` before the first session) on v2, pass only the
    // explicit CLI --plan intent — and only when the engine is not already
    // applying `defaultPlanMode` at create time.
    const explicitPlanMode =
      this.session !== undefined || !this.engineV2
        ? this.store.state.planMode
        : this.options.startup.plan && this.store.state.configDefaultPlanMode !== true;
    const options: MutableCreateSessionOptions = {
      workDir: this.store.state.workDir,
      model,
      // With an active session, carry the live effort. Session-less (lazy
      // creation / `/new` before the first session), carry the session-only
      // thinking override chosen via Alt+S if any — never the initial 'off'
      // default.
      thinking:
        this.session === undefined
          ? this.store.state.lazySessionThinking
          : this.store.state.thinkingEffort,
      permission: this.store.state.permissionMode,
      planMode: explicitPlanMode ? true : undefined,
    };
    if (this.store.state.additionalDirs.length > 0) {
      options.additionalDirs = [...this.store.state.additionalDirs];
    }
    if (bindStartupAgent) {
      // The --agent/--agent-file startup binding is consumed by the first
      // lazy-created session; `/new` sessions fall back to the default profile.
      if (this.store.state.agentProfile !== undefined) {
        options.agentProfile = this.store.state.agentProfile;
      }
      if (this.store.state.agentFiles !== undefined) {
        options.agentFiles = [...this.store.state.agentFiles];
      }
    }
    return this.harness.createSession(options);
  }

  /**
   * Lazy-create the session on first use (v2 engine, session-less startup).
   * Returns the existing session, or creates one from the current state and
   * runs the same assembly `createNewSession` performs.
   */
  async ensureSession(): Promise<Session | undefined> {
    // Even when a session is already assigned, a previous lazy creation may
    // still be finishing its assembly. Wait for it so callers never dispatch
    // against a partially initialized session.
    if (this.ensureSessionPromise !== null) return this.ensureSessionPromise;
    if (this.session !== undefined) return this.session;
    this.ensureSessionPromise = this.lazyCreateSession().finally(() => {
      this.ensureSessionPromise = null;
    });
    return this.ensureSessionPromise;
  }

  /** Await the in-flight lazy session creation, if any (v2); no-op otherwise. */
  async waitForLazyCreation(): Promise<void> {
    await this.ensureSessionPromise;
  }

  private async lazyCreateSession(): Promise<Session | undefined> {
    let session: Session;
    try {
      session = await this.createSessionFromCurrentState(true);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a session: ${msg}`);
      return undefined;
    }
    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return undefined;
    }
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    void this.showSessionWarnings(session);
    // The session-only thinking override was consumed by this session; the
    // runtime status now owns the displayed effort.
    if (this.store.state.lazySessionThinking !== undefined) {
      this.setAppState({ lazySessionThinking: undefined });
    }
    return session;
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.eventBus = createEventBus(session);
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
    this.workflowPanelController.subscribe(session);
    this.syncAdditionalDirs(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const [status, goalResult] = await Promise.all([session.getStatus(), session.getGoal()]);
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinkingEffort: status.thinkingEffort,
      permissionMode: status.permission,
      planMode: status.planMode,
      swarmMode: status.swarmMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
    this.syncAdditionalDirs(session);
    this.syncActivityPaneState();
  }

  /**
   * Compute the live activity-pane mode + tip + detail and write them
   * back to the tui2 store. The MainShell reads from the store, so a
   * single refresh of this method propagates to the activity pane.
   * Cheap (no I/O) and safe to call from any render-relevant path.
   */
  syncActivityPaneState(): void {
    const effective = this.resolveActivityPaneMode();
    const next: typeof this.store.state.activityMode =
      effective === 'hidden' || effective === 'session'
        ? 'idle'
        : (effective as 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool');
    if (this.store.state.activityMode !== next) {
      this.store.setState('activityMode', next);
    }
    const tip = loadingTipKind(effective);
    const tipText = tip === undefined ? undefined : t(`tui.loadingTips.${tip}.text`);
    if (this.store.state.activityTip !== tipText) {
      this.store.setState('activityTip', tipText);
    }
  }

  // Apply --auto/--yolo/--plan startup flags to a resumed session. The resumed
  // session may already be in plan mode from its persisted records, and
  // re-entering plan mode throws, so only enable it when it is not active yet.
  private async applyStartupModesToResumedSession(session: Session): Promise<void> {
    const { startup } = this.options;
    if (startup.auto) {
      await session.setPermission('auto');
    } else if (startup.yolo) {
      await session.setPermission('yolo');
    }
    if (startup.plan) {
      const status = await session.getStatus();
      if (!status.planMode) {
        await session.setPlanMode(true);
      }
    }
  }

  // Re-apply startup flags that the user explicitly passed on the command line.
  private applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.options;
    if (startup.auto) {
      this.setAppState({ permissionMode: 'auto' });
    } else if (startup.yolo) {
      this.setAppState({ permissionMode: 'yolo' });
    }
    if (startup.plan) {
      this.setAppState({ planMode: true });
    }
  }

  // Plan mode is set by createSession — do not re-enter it here.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.store.state.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.workflowPanelController.unsubscribe();
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.store.setState('swarmModeEntry', undefined);
    this.harness.setTelemetryContext({ sessionId: null });
    this.setAppState({ goal: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.store.state.sessionsScope): Promise<void> {
    this.store.setState('loadingSessions', true);
    this.store.setState('sessionsScope', scope);
    this.store.setState('sessionsNextCursor', undefined);
    this.store.setState('sessionsLoadingMore', false);
    try {
      const page = await this.harness.listSessionsPage({
        workDir: scope === 'all' ? undefined : this.store.state.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
      });
      this.store.setState('sessionsNextCursor', page.nextCursor);
      this.store.setState(
        'sessions',
        sessionRowsForPicker(page.items, this.store.state.sessionId, this.hasSessionContent()),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn('failed to fetch sessions for picker', { error: String(error) });
    } finally {
      this.store.setState('loadingSessions', false);
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.store.state.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.cacheHint.resetRuntime();
    this.switchLossBaseline = undefined;
    this.pendingBundledSkillNames.clear();
    this.lastDispatchedUserEntryId = undefined;
    this.streamingUI.discardPending();
    this.store.setState('queuedMessages', []);
    this.store.setState('swarmModeEntry', undefined);
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.store.setState('backgroundCounts', { bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  Command copied to clipboard`, 'warning');
    } catch {
      this.showStatus(`${message}\n  Failed to copy command to clipboard`, 'warning');
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state.
    await this.waitForLazyCreation();
    if (targetSessionId === this.store.state.sessionId) {
      this.showStatus(t('tui.statusMessages.alreadyOnSession'));
      return true;
    }
    if (this.store.state.streamingPhase !== 'idle') {
      this.showError(t('tui.statusMessages.cannotSwitchWhileStreaming'));
      return false;
    }
    if (this.store.state.isReplaying) {
      this.showError(t('tui.statusMessages.cannotSwitchWhileReplaying'));
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({
        id: targetSessionId,
        replayTurnLimit: REPLAY_TURN_LIMIT,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
    void this.cacheHint.maybeShowOnResume();
  }

  async reloadCurrentSessionView(session: Session, statusMessage: string): Promise<void> {
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.approvalController.cancelAll('reloading session');
    this.questionController.cancelAll('reloading session');

    this.resetSessionRuntime();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the reloaded session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async createNewSession(): Promise<void> {
    if (this.store.state.isReplaying) {
      this.showError(t('tui.statusMessages.cannotStartNewWhileReplaying'));
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(`Started a new session (${session.id}).`);
    void this.showSessionWarnings(session);
    void this.showConfigWarningsIfAny();
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.showStatus(warning, 'warning');
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.store.setState('transcript', [...this.store.state.transcript, entry]);
    this.trimTranscriptWindow();
    this.mergeCurrentTurnSteps();
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    if (
      request.toolName === 'ExitPlanMode' ||
      request.display.kind === 'plan_review' ||
      request.display.kind === 'goal_start'
    ) {
      return;
    }
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(
          response.scope === 'session' ? t('tui.statusMessages.approvedForSession') : 'Approved',
        );
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.terminal.write(deleteAllKittyImages());
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.store.setState('transcript', []);
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.btwPanelController.clear();
    this.clearTerminalInlineImages();
    this.store.setState('todoItems', []);
    this.imageStore.clear();
    this.renderWelcome();
  }

  private isTurnBoundaryEntry(entry: TranscriptEntry): boolean {
    if (
      entry.kind !== 'user' &&
      entry.kind !== 'skill_activation' &&
      entry.kind !== 'plugin_command'
    ) {
      return false;
    }
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith('replay:');
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.store.state.isReplaying) return false;

    const entries = this.store.state.transcript;
    const turns = groupTurns(entries);
    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        this.imageStore.removeMany(entry.imageAttachmentIds);
      }
    }

    this.store.setState(
      'transcript',
      entries.filter((e) => !toRemove.has(e)),
    );
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const entries = this.store.state.transcript;

    // Find the start of the current turn (last turn-starting user message).
    let turnStart = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.isTurnBoundaryEntry(entries[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.kind === 'status' && entry.stepSummary === true) {
        summaryIndex = i;
        continue;
      }
      if (entry.kind === 'assistant') {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const entry = entries[idx]!;
      if (entry.kind === 'thinking') thinkingCount++;
      else if (entry.kind === 'tool_call') toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    const toMergeSet = new Set(toMergeIndices);
    const newEntries: TranscriptEntry[] = [];
    for (let i = 0; i <= turnStart; i++) newEntries.push(entries[i]!);
    if (summaryIndex >= 0) {
      const summary = entries[summaryIndex]!;
      newEntries.push({
        ...summary,
        stepSummaryCounts: {
          thinking: (summary.stepSummaryCounts?.thinking ?? 0) + thinkingCount,
          tool: (summary.stepSummaryCounts?.tool ?? 0) + toolCount,
          assistant: (summary.stepSummaryCounts?.assistant ?? 0) + assistantMergeCount,
        },
      });
    } else {
      newEntries.push({
        id: nextTranscriptId(),
        kind: 'status',
        turnId: entries[turnStart]?.turnId,
        renderMode: 'plain',
        content: '',
        stepSummary: true,
        stepSummaryCounts: {
          thinking: thinkingCount,
          tool: toolCount,
          assistant: assistantMergeCount,
        },
      });
    }
    for (let i = turnStart + 1; i < entries.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newEntries.push(entries[i]!);
    }

    this.store.setState('transcript', newEntries);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0) {
      return;
    }
    const entries = this.store.state.transcript;

    const boundaries: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (this.isTurnBoundaryEntry(entries[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newEntries: TranscriptEntry[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newEntries.push(entries[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : entries.length;
      newEntries.push(entries[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const entry = entries[i]!;
        if (entry.kind === 'status' && entry.stepSummary === true) summaryIndex = i;
        else if (entry.kind === 'assistant') assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies.
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const entry = entries[idx]!;
          if (entry.kind === 'thinking') thinkingCount++;
          else if (entry.kind === 'tool_call') toolCount++;
        }
        const toMergeSet = new Set(toMergeIndices);
        if (summaryIndex >= 0) {
          const summary = entries[summaryIndex]!;
          newEntries.push({
            ...summary,
            stepSummaryCounts: {
              thinking: (summary.stepSummaryCounts?.thinking ?? 0) + thinkingCount,
              tool: (summary.stepSummaryCounts?.tool ?? 0) + toolCount,
              assistant: (summary.stepSummaryCounts?.assistant ?? 0) + assistantMergeCount,
            },
          });
        } else {
          newEntries.push({
            id: nextTranscriptId(),
            kind: 'status',
            turnId: entries[turnStart]?.turnId,
            renderMode: 'plain',
            content: '',
            stepSummary: true,
            stepSummaryCounts: {
              thinking: thinkingCount,
              tool: toolCount,
              assistant: assistantMergeCount,
            },
          });
        }
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newEntries.push(entries[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newEntries.push(entries[i]!);
      }
    }

    this.store.setState('transcript', newEntries);
  }

  showStatus(message: string, color?: ColorToken): void {
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'plain',
      content: message,
      color,
    });
  }

  showNotice(title: string, detail?: string): void {
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'notice',
      content: title,
      detail,
    });
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    this.store.setState('progressSpinner', { label });
    return {
      stop: ({ ok, label: finalLabel }) => {
        const symbol = ok ? '✓' : '✗';
        this.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'status',
          renderMode: 'plain',
          content: `${symbol} ${finalLabel}`,
          color: ok ? 'success' : 'error',
        });
        this.store.setState('progressSpinner', null);
      },
      setLabel: (nextLabel) => {
        this.store.setState('progressSpinner', { label: nextLabel });
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    const entry = {
      id: nextTranscriptId(),
      kind: 'status' as const,
      renderMode: 'notice' as const,
      content: t('tui.chrome.deviceCodeBox.title'),
      detail: `${auth.verificationUriComplete}\n${auth.userCode}`,
    };
    this.appendTranscriptEntry(entry);
    // Rounded login card replaces the plain notice row for this entry
    // (v1 mounted a `DeviceCodeBoxComponent` transcript child here).
    setDeviceCodeCard({
      entryId: entry.id,
      title: t('tui.chrome.deviceCodeBox.title'),
      url: auth.verificationUriComplete,
      code: auth.userCode,
      hint: t('tui.chrome.deviceCodeBox.hint'),
    });
    return this.showLoginProgressSpinner(t('tui.statusMessages.waitingForAuthorization'));
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  /** Rebuild the right-side agent status panel from the transcript. */
  updateAgentPane(): void {
    const items: AgentPaneItem[] = [];
    const phase = this.store.state.streamingPhase;
    items.push({
      id: 'main',
      name: t('tui.chrome.agentPane.mainAgent'),
      status: phase === 'idle' ? 'done' : 'active',
      detail: phase === 'idle' ? undefined : mainAgentPhaseLabel(phase),
    });
    for (const entry of this.store.state.transcript) {
      if (entry.kind !== 'tool_call') continue;
      const data = entry.toolCallData;
      if (data === undefined || data.name !== 'Agent') continue;
      const subagent = data.subagent;
      if (subagent === undefined || subagent.name === undefined) continue;
      items.push({
        id: data.id,
        name: subagent.name,
        status: subagentStatus(data),
        detail: subagent.text?.split('\n').at(-1),
      });
    }
    this.store.setState('agentPaneItems', items);
  }

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
      this.store.setState('activityTip', undefined);
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
      this.store.setState('activityTip', this.currentLoadingTip.tip);
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const retry = effectiveMode === 'waiting' ? this.store.state.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${retryKey}`;
    if (activityModeKey === this.lastActivityMode) return;
    this.lastActivityMode = activityModeKey;
    // The store's livePane.mode is a LivePaneMode; map the shell/composing
    // phases back to the spinner modes they render as.
    const paneMode: LivePaneState['mode'] =
      effectiveMode === 'hidden' || effectiveMode === 'session'
        ? this.store.state.livePane.mode
        : effectiveMode === 'shell' || effectiveMode === 'composing'
          ? 'waiting'
          : effectiveMode;
    this.patchLivePane({ mode: paneMode });
  }

  toggleActivityPane(): void {
    this.patchLivePane({
      activityPaneVisible: !this.store.state.livePane.activityPaneVisible,
    });
  }

  /** Toggle the right-side agent status panel (leader+p). */
  toggleAgentPane(): void {
    this.store.setState('agentPaneVisible', !this.store.state.agentPaneVisible);
  }

  /** Toggle the right-side diff review panel (leader+r). */
  toggleDiffReviewPane(): void {
    this.store.setState('diffReviewPaneVisible', !this.store.state.diffReviewPaneVisible);
  }

  /** Rebuild the right-side diff review panel from the transcript. */
  updateDiffReviewPane(): void {
    const items: DiffReviewItem[] = [];
    const seen = new Set<string>();
    for (const entry of this.store.state.transcript) {
      if (entry.kind !== 'tool_call') continue;
      const display = entry.toolCallData?.display;
      if (display === undefined) continue;
      let path: string | undefined;
      let before: string | undefined;
      let after: string | undefined;
      if (display.kind === 'diff') {
        path = display.path;
        before = display.before;
        after = display.after;
      } else if (
        display.kind === 'file_io' &&
        display.before !== undefined &&
        display.after !== undefined
      ) {
        path = display.path;
        before = display.before;
        after = display.after;
      }
      if (path === undefined || before === undefined || after === undefined) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      items.push({ path, before, after });
    }
    this.store.setState('diffReviewItems', items);
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (!this.store.state.livePane.activityPaneVisible) return 'hidden';
    if (this.store.state.activeDialog === 'session-picker') return 'hidden';
    if (this.store.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.store.state.isCompacting) return 'hidden';
    if (this.store.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.store.state.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.store.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.store.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    // The queue pane renders from `store.state.queuedMessages` directly.
  }

  toggleToolOutputExpansion(): void {
    const next = !this.store.state.toolOutputExpanded;
    this.store.setState('toolOutputExpanded', next);
    // Flip the `expanded` flag on recent expandable transcript entries.
    const entries = this.store.state.transcript;
    const boundaries: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (this.isTurnBoundaryEntry(entries[i]!)) boundaries.push(i);
    }
    const expandCutoff =
      TRANSCRIPT_EXPAND_TURNS <= 0
        ? entries.length
        : boundaries.length > TRANSCRIPT_EXPAND_TURNS
          ? boundaries[boundaries.length - TRANSCRIPT_EXPAND_TURNS]!
          : 0;
    this.store.setState('transcript', (current) =>
      current.map((entry, i) => {
        if (i < expandCutoff) return entry;
        if (entry.kind !== 'tool_call' && entry.kind !== 'thinking' && entry.kind !== 'goal') {
          return entry;
        }
        return { ...entry, expanded: next };
      }),
    );
  }

  toggleTodoPanelExpansion(): void {
    this.store.setState('todoPanelExpanded', !this.store.state.todoPanelExpanded);
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint('No shell command running.');
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint('Command is still starting — try again.');
      return;
    }
    const session = this.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint('Command already finished.');
        return;
      }
    } catch (error) {
      this.showError(`Failed to move to background: ${formatErrorMessage(error)}`);
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution is a no-op instead of overwriting this view.
    stream.entry.content = t('tui.messages.shellRun.backgrounded');
    this.store.patch('shellOutputs', {
      [commandId]: { content: t('tui.messages.shellRun.backgrounded'), finished: true },
    });
    this.shellOutputStreams.delete(commandId);
    this.showDetachHint('Moved to background. /tasks to view.');
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.shellOutputStreams.size > 0) {
      await this.detachRunningShellCommand();
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(getNoActiveSessionMessage());
      return;
    }

    let tasks: readonly BackgroundTaskInfo[];
    try {
      // activeOnly defaults to true; foreground running tasks are non-terminal
      // and therefore included. We filter to `detached === false` ourselves.
      tasks = await session.listBackgroundTasks();
    } catch (error) {
      this.showError(`Failed to list tasks: ${formatErrorMessage(error)}`);
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint('No foreground task running.');
      return;
    }

    let detached = 0;
    let alreadyFinished = 0;
    for (const target of targets) {
      try {
        const info = await session.detachBackgroundTask(target.taskId);
        if (info === undefined) alreadyFinished++;
        else detached++;
      } catch (error) {
        this.showError(`Failed to detach ${target.taskId}: ${formatErrorMessage(error)}`);
      }
    }

    let hint: string;
    if (detached === 0 && alreadyFinished > 0) {
      hint =
        alreadyFinished === 1
          ? t('tui.statusMessages.taskAlreadyFinished_one')
          : t('tui.statusMessages.taskAlreadyFinished_other');
    } else if (detached === targets.length) {
      hint =
        detached === 1
          ? t('tui.statusMessages.movedOneTaskToBackground')
          : `Moved ${detached} tasks to background.`;
    } else {
      hint = `Moved ${detached} of ${targets.length} tasks to background.`;
    }
    if (detached > 0) hint = `${hint} /tasks to view.`;
    this.showDetachHint(hint);
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.store.setState('footerTransientHint', hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint that took over while this timer
      // was pending.
      if (this.store.state.footerTransientHint !== hint) return;
      this.store.setState('footerTransientHint', null);
    }, DETACH_HINT_DISPLAY_MS);
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.store.state.editorDraft).trimStart();
    const isBash = this.store.state.inputMode === 'bash';
    const highlighted = this.store.state.planMode || isBash || trimmed.startsWith('/');
    this.store.setState('editorBorderHighlighted', highlighted);
    this.store.setState(
      'editorBorderToken',
      isBash ? 'shellMode' : highlighted ? 'primary' : 'border',
    );
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.store.state.theme) || this.store.state.theme !== 'auto') return;

    // Terminal theme tracking is a v1 renderer concern; the tui2 shell applies
    // the resolved palette via applyResolvedAutoTheme when the renderer reports
    // a theme change.
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.store.state.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.store.state.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.store.state.terminalState.supportsProgress) return;
    if (this.store.state.terminalState.progressActive === active) return;
    this.terminal.setProgress(active);
    this.store.patch('terminalState', { progressActive: active });
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: unknown): void {
    if (panel === null || panel === undefined) {
      this.store.setState('editorReplacement', undefined);
      return;
    }
    if (typeof panel === 'object' && panel !== null && 'component' in panel) {
      this.store.setState('editorReplacement', panel as never);
    }
  }

  restoreEditor(): void {
    this.store.setState('activeDialog', null);
    this.store.setState('editorReplacement', undefined);
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.store.setState('editorDraft', text);
    this.updateEditorBorderHighlight(text);
  }

  /** Latest in-process LLM round-trip; feeds the idle cache-hint scenario. */
  recordSessionActivity(): void {
    this.cacheHint.recordActivity();
  }

  /** Per-step usage for the client-side cache-break detector. */
  noteStepUsage(usage: TokenUsage | undefined): void {
    if (
      usage !== undefined &&
      !(usage.inputOther === 0 && usage.output === 0 && usage.inputCacheRead === 0 &&
        usage.inputCacheCreation === 0)
    ) {
      this.switchLossBaseline = usage;
    }
    this.cacheHint.noteStepUsage(usage);
  }

  /**
   * Last measured step's full input size — what a model/effort switch would
   * reprocess against the provider prompt cache. Mirrors the cache-hint
   * controller's baseline rule; cleared on context cuts and compaction.
   */
  estimateSwitchLossTokens(): number | undefined {
    const baseline = this.switchLossBaseline;
    if (baseline === undefined) return undefined;
    const total =
      baseline.inputOther +
      baseline.inputCacheRead +
      baseline.inputCacheCreation;
    return total > 0 ? total : undefined;
  }

  /**
   * Per-step cache-hit and output-speed accounting for the footer readout.
   */
  noteStepCacheStats(usage: TokenUsage | undefined, streamDurationMs: number | undefined): void {
    const patch: Partial<AppState> = {};
    if (usage !== undefined) {
      const read = usage.inputCacheRead ?? 0;
      const miss = usage.inputCacheCreation ?? 0;
      if (read > 0 || miss > 0 || (usage.inputOther ?? 0) > 0) {
        patch.cacheReadTokens = this.store.state.cacheReadTokens + read;
        patch.cacheMissTokens = this.store.state.cacheMissTokens + miss;
        patch.cacheOtherTokens = this.store.state.cacheOtherTokens + (usage.inputOther ?? 0);
      }
    }
    if (
      usage !== undefined &&
      (usage.output ?? 0) > 0 &&
      streamDurationMs !== undefined &&
      streamDurationMs > 0
    ) {
      patch.tokenSpeed = (usage.output! / streamDurationMs) * 1000;
    }
    if (Object.keys(patch).length > 0) {
      this.setAppState(patch);
    }
  }

  /** Session turn counter for the footer stats. */
  noteSessionTurnStarted(): void {
    this.setAppState({
      sessionStats: bumpTurnCount(this.store.state.sessionStats),
    });
  }

  /** Fold one completed step (usage + timing) into the footer session stats. */
  noteSessionStepCompleted(
    usage: TokenUsage | undefined,
    llmStreamDurationMs: number | undefined,
    llmFirstTokenLatencyMs: number | undefined,
  ): void {
    this.setAppState({
      sessionStats: accumulateStepCompleted(
        this.store.state.sessionStats,
        usage,
        llmStreamDurationMs,
        llmFirstTokenLatencyMs,
      ),
    });
  }

  /** Accumulate one tool-call wall time into the footer session stats. */
  noteSessionToolCompleted(deltaMs: number): void {
    this.setAppState({
      sessionStats: accumulateToolDuration(this.store.state.sessionStats, deltaMs),
    });
  }

  /** Compaction shrinks the cached prefix — reset the cache-break baseline. */
  noteCompactionFinished(): void {
    this.cacheHint.resetCacheBreakBaseline();
    this.switchLossBaseline = undefined;
  }

  /** /undo cut the context — the next step's cache drop is expected. */
  noteContextCut(): void {
    this.cacheHint.resetCacheBreakBaseline();
    this.switchLossBaseline = undefined;
  }

  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    // opentui migration flow: ask → progress → result, driven through the
    // editor-replacement slot (see commands/migration-screen.tsx).
    const result = await runMigrationFlow({
      host: this,
      plan,
      sourceHome: plan.sourceHome,
      targetHome: this.harness.homeDir,
      skipDecisionStep: this.migrateOnly,
    });
    if (result.decision === 'never') {
      // Persist the skip marker `detectPendingMigration` checks, so "Never ask
      // again" actually stops the prompt from reappearing every launch.
      try {
        writeFileSync(join(this.harness.homeDir, '.skip-migration-from-kimi-cli'), '', 'utf-8');
      } catch {
        // Non-blocking: a failed marker write must never crash startup.
      }
    }
    return result;
  }

  /**
   * agent-core-v2 startup gate: before any session is created, ask whether to
   * trust this folder when the workspace is not trusted yet. Best-effort
   * throughout — a failed check or trust write never blocks startup.
   */
  private async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    if (!this.engineV2) return false;
    const workDir = this.store.state.workDir;
    let info: WorkspaceTrustInfo;
    try {
      info = await this.harness.getWorkspaceTrustInfo(workDir);
    } catch {
      return false;
    }
    if (info.trusted) return false;
    const choice = await new Promise<TrustPromptChoice>((resolvePromise) => {
      this.trustPromptResolver = resolvePromise;
      this.store.setState('activeDialog', 'trust-prompt');
    });
    this.trustPromptResolver = undefined;
    this.store.setState('activeDialog', null);
    if (choice !== 'trust') {
      // Declining trust exits the program (Claude Code's "No, exit" semantics).
      await this.stop();
      return true;
    }
    try {
      await this.harness.trustWorkspace(workDir);
    } catch {
      // A failed write leaves the workspace untrusted (re-asked next launch).
    }
    return true;
  }

  /** Resolve the open trust prompt (called by the trust-prompt dialog). */
  resolveTrustPrompt(choice: TrustPromptChoice): void {
    this.trustPromptResolver?.(choice);
  }

  /**
   * One-time MSYS2 install gate (Windows only). When no MSYS2 bash is
   * available and the prompt has not been shown before, asks the user whether
   * to install MSYS2 via winget and switch the shell to it.
   */
  private async maybeRunMsys2Prompt(_eventLoopStarted: boolean): Promise<boolean> {
    const deps = createMsys2PromptDeps();
    if (!(await shouldPromptMsys2(deps))) return false;
    const choice = await new Promise<Msys2PromptChoice>((resolvePromise) => {
      this.msys2PromptResolver = resolvePromise;
      this.store.setState('activeDialog', 'msys2-prompt');
    });
    this.msys2PromptResolver = undefined;
    this.store.setState('activeDialog', null);
    if (choice === 'install') {
      const spinner = this.showProgressSpinner(t('tui.dialogs.msys2Prompt.installing'));
      const result = await installMsys2(deps);
      if (result.ok && result.bashPath !== undefined) {
        const switched = setUserShellPath(result.bashPath, deps);
        spinner.stop({ ok: true, label: t('tui.dialogs.msys2Prompt.installSuccess') });
        this.showStatus(
          switched ? t('tui.dialogs.msys2Prompt.restartHint') : t('tui.dialogs.msys2Prompt.installSuccessNoSwitch'),
        );
        await markPrompted(deps);
      } else {
        spinner.stop({ ok: false, label: t('tui.dialogs.msys2Prompt.installFailed') });
        this.showError(result.error ?? t('tui.dialogs.msys2Prompt.installFailed'));
        this.showStatus(t('tui.dialogs.msys2Prompt.manualInstallHint'));
      }
    } else {
      await markPrompted(deps);
    }
    return true;
  }

  /** Resolve the open msys2 prompt (called by the msys2-prompt dialog). */
  resolveMsys2Prompt(choice: Msys2PromptChoice): void {
    this.msys2PromptResolver?.(choice);
  }

  showHelpPanel(): void {
    this.store.setState('helpPanel', {
      commands: this.getSlashCommands(),
      width: process.stdout.columns ?? 80,
    });
    this.store.setState('activeDialog', 'help');
  }

  private hideHelpPanel(): void {
    this.store.setState('helpPanel', undefined);
    this.store.setState('activeDialog', null);
  }

  showWhichKey(): void {
    this.store.setState('activeDialog', 'which-key');
  }

  private hideWhichKey(): void {
    this.store.setState('activeDialog', null);
  }

  private leaderOverlayVisible = false;

  showLeaderOverlay(): void {
    if (this.leaderOverlayVisible) return;
    this.leaderOverlayVisible = true;
    this.store.setState('leaderOverlayVisible', true);
  }

  hideLeaderOverlay(): void {
    if (!this.leaderOverlayVisible) return;
    this.leaderOverlayVisible = false;
    this.store.setState('leaderOverlayVisible', false);
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;
  private sessionsPageFetchInFlight: Promise<boolean> | undefined;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions('cwd');
    this.store.setState('activeDialog', 'session-picker');
  }

  /** Toggle the session picker between cwd / all scope (Ctrl+A in the picker). */
  async toggleSessionPickerScope(_selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.store.state.sessionsScope === 'cwd' ? 'all' : 'cwd';
    await this.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.store.state.activeDialog !== 'session-picker') return;
  }

  /** Load the next page of sessions and append it to the picker list. */
  async loadMoreSessions(): Promise<void> {
    const before = this.store.state.sessionsNextCursor;
    if (before === undefined) return;
    if (this.store.state.sessionsLoadingMore) return;
    const scope = this.store.state.sessionsScope;
    this.store.setState('sessionsLoadingMore', true);
    try {
      const page = await this.harness.listSessionsPage({
        workDir: scope === 'all' ? undefined : this.store.state.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
        before,
      });
      this.store.setState('sessionsNextCursor', page.nextCursor);
      this.store.setState(
        'sessions',
        [...this.store.state.sessions, ...sessionRowsForPicker(page.items, this.store.state.sessionId, this.hasSessionContent())],
      );
    } catch (error) {
      log.warn('failed to load more sessions', { error: String(error) });
    } finally {
      this.store.setState('sessionsLoadingMore', false);
    }
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.editorKeyboard.clearPendingExit();
    this.store.setState('activeDialog', null);
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this as unknown as SlashCommandHost, '');
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.store.state.workDir)) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  /** Select a session from the picker (called by the session-picker dialog). */
  selectSession(session: SessionRow, applyStartupModes = false): void {
    void this.handleSessionPickerSelect(session, applyStartupModes).catch((error) => {
      this.showError(
        t('tui.statusMessages.failedToApplyStartupFlags', {
          message: formatErrorMessage(error),
        }),
      );
    });
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(
      {
        notifications: this.store.state.notifications,
        terminalState: this.store.state.terminalState,
        write: (data) => this.terminal.write(data),
      },
      `approval:${payload.id}`,
      {
        title: t('tui.messages.kimiTuiApprovalRequired'),
        body: payload.tool_name,
      },
    );
  }

  private hideApprovalPanel(): void {
    this.patchLivePane({ pendingApproval: null });
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(
      {
        notifications: this.store.state.notifications,
        terminalState: this.store.state.terminalState,
        write: (data) => this.terminal.write(data),
      },
      `question:${payload.id}`,
      {
        title: t('tui.messages.kimiTuiNeedsAnswer'),
        body: payload.questions[0]?.question,
      },
    );
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
  }
}

export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from '../types';
