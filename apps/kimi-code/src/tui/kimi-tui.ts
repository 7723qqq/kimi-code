import { writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import { effectiveModelAlias, log } from '@moonshot-ai/kimi-code-sdk';
import type {
  BackgroundTaskInfo,
  CreateSessionOptions,
  Event,
  KimiHarness,
  PermissionMode,
  PluginCommandDef,
  Session,
  SkillSummary,
  TokenUsage,
  WorkspaceTrustInfo,
} from '@moonshot-ai/kimi-code-sdk';
import { isTelemetryDisabledByEnv } from '@moonshot-ai/kimi-telemetry';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import {
  type Component,
  type Focusable,
  getCapabilities,
  Key,
  matchesKey,
  Spacer,
  TuiAltScreen,
  TuiMainScreen,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { resolve } from 'pathe';

import {
  createMsys2PromptDeps,
  installMsys2,
  markPrompted,
  setUserShellPath,
  shouldPromptMsys2,
} from '#/cli/msys2-prompt';
import type { CLIOptions } from '#/cli/options';
import { getLocale, t } from '#/i18n';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { applyRecommendedEffort } from '#/utils/recommended-effort';
import { getRecommendedEffortConfig } from '#/utils/recommended-effort-config';
import { quoteShellArg } from '#/utils/shell-quote';
import { startupTrace } from '#/utils/startup-trace';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import { resolveBannerAudienceContext, type BannerAudienceContext } from './banner/audience';
import { BannerProvider } from './banner/banner-provider';
import { readBannerDisplayState, writeBannerDisplayState } from './banner/state';
import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  goalObjectiveLengthWarning,
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
  sortSlashCommands,
  type KimiSlashCommand,
  type SkillListSession,
} from './commands';
import * as slashCommands from './commands/dispatch';
import { BannerComponent } from './components/chrome/banner';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { GutterContainer } from './components/chrome/gutter-container';
import { MoonLoader } from './components/chrome/moon-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import { defaultThinkingEffortFor } from './components/dialogs/model-selector';
import { Msys2PromptComponent, type Msys2PromptChoice } from './components/dialogs/msys2-prompt';
import { type SessionRow } from './components/dialogs/session-picker';
import { TrustPromptComponent, type TrustPromptChoice } from './components/dialogs/trust-prompt';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from './components/editor/file-mention-provider';
import { ShellRunComponent } from './components/messages/shell-run';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  getLlmNotSetMessage,
  getNoActiveSessionMessage,
  PRODUCT_NAME,
  SESSION_LIST_PAGE_SIZE,
  SESSIONLESS_STARTUP_NOTICE,
  SHUTTING_DOWN_HINT,
} from './constant/kimi-tui';
import { CHROME_GUTTER } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { ActivityPaneController } from './controllers/activity-pane';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { CacheHintController } from './controllers/cache-hint-controller';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint';
import { DialogHostController } from './controllers/dialog-host';
import {
  EditorKeyboardController,
  type ActiveExclusiveMode,
  type ReviewCycleMode,
} from './controllers/editor-keyboard';
import { MessageDispatchController } from './controllers/message-dispatch';
import { PromptOptimizerController } from './controllers/prompt-optimizer';
import type { StatusSurfaceKey } from './components/chrome/status-surface/region';
import { SessionEventHandler } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StagingLeaseTracker } from './controllers/staging-leases';
import { StreamingUIController } from './controllers/streaming-ui';
import { SurveyController } from './controllers/survey-controller';
import { TasksBrowserController } from './controllers/tasks-browser';
import { TranscriptRendererController } from './controllers/transcript-renderer';
import { installRainbowDance } from './easter-eggs/dance';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import { currentTheme, getColorPalette, getBuiltInPalette, isBuiltInTheme } from './theme';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme';
import { createTUIState, type TUIState } from './tui-state';
import {
  INITIAL_LIVE_PANE,
  sumTokenUsage,
  type AppState,
  type InlineSkillActivation,
  type PreparedSkillActivations,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type SteerInputItem,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import {
  countedByExpandHint,
  hasHiddenContent,
  isExpandable,
  isExpandedComponent,
} from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { pickForegroundTasks } from './utils/foreground-task';
import { ImageAttachmentStore, type ImageAttachment, type MediaAttachment } from './utils/image-attachment-store';
import {
  extractMediaAttachments,
  omitExpiredVideoFileRefs,
  originalsDirForSession,
  pendingMediaIngestions,
  refreshExpiringImageFileRefs,
  resolveOriginalCaptions,
  rewriteMediaPlaceholders,
} from './utils/image-placeholder';
import type { ExtractionResult } from './utils/image-placeholder';
import { installInputLatencyProbe } from './utils/input-latency';
import { REPLAY_TURN_LIMIT } from './utils/message-replay';
import { hasPatchChanges } from './utils/object-patch';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import {
  accumulateStepCompleted,
  accumulateToolDuration,
  bumpTurnCount,
  createEmptySessionStats,
} from './utils/session-stats';
import { formatBashOutputForDisplay } from './utils/shell-output';
import { combineStartupNotice, isOAuthLoginRequiredError } from './utils/startup';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { thinkingEffortFromConfig } from './utils/thinking-config';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import { TokenSpeedSampler } from './utils/token-speed';
import { nextTranscriptId } from './utils/transcript-id';
import { expandCutoffIndex, TRANSCRIPT_EXPAND_TURNS } from './utils/transcript-window';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from './types';

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
  readonly telemetryDisabled?: boolean;
}

type TurnStartedEvent = Extract<Event, { type: 'turn.started' }>;
type TurnEndedEvent = Extract<Event, { type: 'turn.ended' }>;

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Whether the editor border renders in the highlighted style. Any mode that
 * constrains what may be written counts, not just plan, so the editor signals
 * spec/swarm/tower sessions too.
 */
export function editorBorderHighlighted(
  appState: Pick<AppState, 'planMode' | 'specMode' | 'swarmMode' | 'towerMode' | 'inputMode'>,
  isBash: boolean,
  trimmedText: string,
): boolean {
  return (
    appState.planMode ||
    appState.specMode ||
    appState.swarmMode ||
    appState.towerMode ||
    isBash ||
    trimmedText.startsWith('/')
  );
}

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    specMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    cacheOtherTokens: 0,
    tokenSpeed: 0,
    tokenSpeedAverage: 0,
    sessionStats: createEmptySessionStats(),
    outputTokens: 0,
    locale: getLocale(),
    cumulativeTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: input.tuiConfig.theme,
    tuiMode: input.tuiConfig.tuiMode,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    renderLatex: input.tuiConfig.renderLatex,
    cacheExpiryHint: input.tuiConfig.cacheExpiryHint,
    disableFeedbackSurvey: input.tuiConfig.disableFeedbackSurvey,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    markdown: input.tuiConfig.markdown,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly mediaSnapshots?: readonly MediaAttachment[];
  readonly hasMedia?: boolean;
  /**
   * Lease pre-created at extraction time by `sendNormalUserInput`. Dispatch
   * reuses it (carrying its exact-binding submission id); enqueueing defers
   * it — the queue item owns the raw ids and re-leases at dequeue.
   */
  readonly lease?: StagingLease;
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

function isUserSubmittedTurnOrigin(origin: TurnStartedEvent['origin'] | undefined): boolean {
  if (origin === undefined) return false;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash';
    case 'shell_command':
      return origin.phase === 'input';
    default:
      return false;
  }
}

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  /** In-flight lazy session creation (v2 engine), shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<Session | undefined> | null = null;
  readonly cacheHint = new CacheHintController(this);
  /** Staged prompt media lifecycle (daemon uploads + cache copies) — see StagingLeaseTracker. */
  private readonly staging: StagingLeaseTracker;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly KimiSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  /** Owns the decode-rate state and its lifetime; see utils/token-speed.ts. */
  private readonly tokenSpeed = new TokenSpeedSampler();
  // Detected lazily in startBackgroundFdAutocomplete() — detection spawns
  // `fd --version`, which must not happen before the workspace trust gate:
  // on Windows a bare command name resolves into the (untrusted) cwd first.
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
  private readonly telemetryDisabled: boolean;
  private startupNotice: string | undefined;
  private lastHistoryContent: string | undefined;
  // Live `!` shell output entries, keyed by commandId so concurrent commands
  // each update their own card and stale events are dropped. Mutated in place
  // as `shell.output` events arrive; removed when the command completes.
  // `taskId` (from `shell.started`) lets ctrl+b detach the exact task.
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; component: ShellRunComponent; taskId?: string }
  >();
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly surveyController: SurveyController;
  readonly promptOptimizer: PromptOptimizerController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly messageDispatch: MessageDispatchController;
  readonly transcriptRenderer: TranscriptRendererController;
  readonly dialogController: DialogHostController;
  readonly activityPaneController: ActivityPaneController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  /** In-flight session-picker "load more" page fetch (see fetchMoreSessions). */
  private sessionsPageFetchInFlight: Promise<boolean> | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  track(
    event: string,
    properties?: Parameters<KimiHarness['track']>[1],
    context?: { readonly sessionId?: string },
  ): void {
    if (context === undefined) {
      this.harness.track(event, properties);
      return;
    }
    this.harness.trackWithContext(event, properties, { sessionId: context.sessionId });
  }

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    this.staging = new StagingLeaseTracker({
      takeFileIds: (ids) => this.imageStore.takeFileIds(ids),
      releaseRetains: (ids) => {
        this.imageStore.releaseRetains(ids);
      },
      deleteFiles: async (fileIds, paths) => {
        await Promise.all([
          ...fileIds.map((fileId) => this.harness.deleteFile(fileId).catch(() => undefined)),
          ...paths.map((path) => unlink(path).catch(() => undefined)),
        ]);
      },
      warn: (message) => {
        this.track('staging_lease_invariant', { message });
      },
    });
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
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
    this.telemetryDisabled = startupInput.telemetryDisabled ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
    this.state.footer.setExpandHintProvider(() => this.toolOutputExpandHint());
    this.state.transcriptContainer.setUnhandledClick((index) => this.toggleClickedFoldBlock(index));
    // The panels row is its own gutter: a click the panel does not claim (anywhere
    // but the tab strip) folds or unfolds the box, through the same capability
    // checks the transcript uses instead of a panel-specific gesture.
    this.state.notifyPanelContainer.setUnhandledClick(() => this.togglePanelsRowFold());
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.dialogController.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.dialogController.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.dialogController.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.dialogController.hideQuestionDialog();
        },
      }),
    );
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this, this.imageStore, this.staging);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.surveyController = new SurveyController(this, {
      accessToken: () => this.harness.auth.getCachedAccessToken(),
      telemetryDisabled: () => isTelemetryDisabledByEnv() || this.telemetryDisabled,
    });
    this.promptOptimizer = new PromptOptimizerController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.messageDispatch = new MessageDispatchController(this, this.staging, this.imageStore);
    this.transcriptRenderer = new TranscriptRendererController(this, this.imageStore, this.staging);
    this.dialogController = new DialogHostController(
      this,
      this.approvalController,
      this.questionController,
    );
    this.activityPaneController = new ActivityPaneController(this);
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] = this.getSlashCommands().map((cmd) => {
      const completer = cmd.completeArgs;
      return {
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        getArgumentCompletions:
          completer !== undefined ? (prefix: string) => completer(prefix) : undefined,
      };
    });
    const skillCommandNames = new Set(this.skillCommandMap.keys());
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.state.appState.additionalDirs,
      () => this.state.appState.inputMode,
      skillCommandNames,
    );
    this.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.state.editor.setArgumentHints(argumentHints);
    this.state.editor.setSkillCommandNames(skillCommandNames);
  }

  refreshSlashCommandAutocomplete(): void {
    this.sessionEventHandler.notifications.setEnabled(isExperimentalFlagEnabled('notify_user'));
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      // Skills live on the workspace handler, not the session, so they are
      // available before the first (lazy) session is created — the workspace
      // catalog is the same merged view a session would serve.
      try {
        const skills = await this.harness.listWorkspaceSkills(this.state.appState.workDir);
        this.applySkillCommands(skills);
        return;
      } catch (error) {
        log.warn('failed to list workspace skills', { error: String(error) });
        return;
      }
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch (error) {
      log.warn('failed to list session skills', { error: String(error) });
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
      // The enabled plugin commands are an app-global live view, available
      // before the first (lazy) session is created.
      try {
        const defs = await this.harness.listPluginCommands();
        this.applyPluginCommands(defs);
        return;
      } catch (error) {
        log.warn('failed to list plugin commands', { error: String(error) });
        return;
      }
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch (error) {
      log.warn('failed to list session plugin commands', { error: String(error) });
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
      const msys2PromptStartedLoop = await this.maybeRunMsys2Prompt(trustPromptStartedLoop);
      startupTrace('msys2Prompt:end');

      if (this.migrationPlan !== null) {
        // Migration needs the event loop running first (pi-tui component).
        // When the trust prompt already started it, starting it again would
        // re-run pi-tui's terminal.start() — stacking a second Kitty
        // keyboard-protocol push and duplicate stdin listeners.
        if (!trustPromptStartedLoop && !msys2PromptStartedLoop) this.startEventLoop();
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            const failed = migrationResult.decision === 'now' && migrationResult.migrated === false;
            this.disposeTerminalTracking();
            this.state.ui.stop();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          const shouldReplayHistory = await this.initMainTui();
          this.startBackgroundFdAutocomplete();
          await this.finishStartup(shouldReplayHistory);
        } catch (error) {
          this.disposeTerminalTracking();
          this.state.ui.stop();
          throw error;
        }
        return;
      }

      startupTrace('initMainTui:begin');
      const shouldReplayHistory = await this.initMainTui();
      startupTrace('initMainTui:end');
      // Debug-only input→render latency overlay (KIMI_TUI_INPUT_LATENCY=1).
      if (process.env['KIMI_TUI_INPUT_LATENCY']) installInputLatencyProbe(this.state.ui);
      // When the trust prompt already started the event loop, starting it
      // again would re-run pi-tui's terminal.start() — stacking a second
      // Kitty keyboard-protocol push (leaking CSI-u mode past exit) and
      // duplicate stdin listeners.
      if (!trustPromptStartedLoop && !msys2PromptStartedLoop) this.startEventLoop();
      startupTrace('eventLoop:started');
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace('finishStartup:begin');
        await this.finishStartup(shouldReplayHistory);
        startupTrace('finishStartup:end');
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const audience = this.harness.auth.getCachedAccessToken().then(
      (accessToken) => resolveBannerAudienceContext(accessToken),
      (): BannerAudienceContext => ({ login: 'unknown' }),
    );
    const banner = await provider.load({
      state: displayState,
      now,
      audience,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === 'always') return;
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

  private renderBanner(): void {
    if (this.state.appState.banner === null || this.state.appState.banner === undefined) {
      return;
    }
    if (this.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(welcomeIndex + 1, 0, banner);
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.transcriptRenderer.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.applyRecommendedEffortInBackground();
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    this.state.ui.start();
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () => this.messageDispatch.supportsCurrentModelCapability('image_in'),
      requestRender: () => {
        this.state.ui.requestRender();
      },
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

  private applyRecommendedEffortInBackground(): void {
    void this.backgroundRefreshPromise?.then(async () => {
      await applyRecommendedEffort({
        fetchConfig: async () =>
          getRecommendedEffortConfig({
            accessToken: await this.harness.auth.getCachedAccessToken(),
          }),
        getConfig: () => this.harness.getConfig(),
        setConfig: (patch) => this.harness.setConfig(patch),
        track: (event, properties) => {
          this.track(event, properties);
        },
      });
    });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(
          t(
            c.added > 1
              ? 'tui.statusMessages.providerModelsAdded_other'
              : 'tui.statusMessages.providerModelsAdded_one',
            { provider: c.providerName, count: c.added },
          ),
        );
      }
      for (const f of result.failed) {
        this.showStatus(
          t('tui.messages.configSkippedRefreshing', {
            provider: f.provider,
            reason: f.reason,
          }),
          'warning',
        );
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
    // warning yellow at boot; `run-prompt`/`run-v2-print` print them to
    // stderr for non-interactive runs.
    void this.showConfigWarningsIfAny();
    if (this.state.startupState === 'picker') {
      void this.dialogController.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(
        t('tui.statusMessages.warningPrefix', { message: resumeState.warning }),
        'warning',
      );
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
        this.showStatus(
          t('tui.statusMessages.warningPrefix', { message: warning.message }),
          severity,
        );
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
    this.sessionEventHandler.notifications.setEnabled(isExperimentalFlagEnabled('notify_user'));
    await this.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
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
    if (this.state.appState.additionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [...this.state.appState.additionalDirs];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.state.ui.stop();
            process.stderr.write(
              `${currentTheme.fg(
                'warning',
                `Session "${startup.sessionFlag}" was created under a different directory.\n` +
                  `  cd "${target.workDir}" && kimi -r ${startup.sessionFlag}`,
              )}\n\n`,
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
              t('tui.statusMessages.noSessionsToContinue', { workDir }),
            );
          }
        }
      } else {
        // Lazy session creation: start session-less and create the session on
        // the first message. Startup flags are carried in appState and applied
        // when that session is created; until then the footer shows the config
        // defaults the engine would apply at createSession time (model,
        // permission, plan mode, thinking effort, context cap).
        await this.hydrateLazyConfigDefaults();
        this.appendStartupNotice(getSessionlessStartupNotice());
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

    if (session !== undefined) {
      await this.setSession(
        session,
        shouldReplayHistory ? session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount : 0,
      );
      await this.syncRuntimeState(session);
    }
    this.applyStartupPermissionAndPlanToAppState();
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    // A Ctrl+C during shutdown means "don't wait for slow hooks": skip the
    // remaining graceful close and get out immediately. Captured at the UI
    // input-listener level so it works no matter which component holds focus
    // (a dialog may have replaced the editor).
    const removeForceExitListener = this.state.ui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl('c'))) return undefined;
      this.forceExitDuringShutdown();
      return { consume: true };
    });
    // Give the startup provider-model refresh a brief chance to finish before
    // the harness closes (and the process exits): its config writes are each
    // atomic, so draining can only ever leave a complete file behind. Bounded
    // so a slow network never delays the exit.
    if (this.backgroundRefreshPromise !== undefined) {
      await Promise.race([
        this.backgroundRefreshPromise,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.activityPaneController.stopActivitySpinner();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.transcriptRenderer.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.surveyController.dispose();
    this.state.footer.dispose();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // closeSession runs SessionEnd hooks, which can take seconds (bounded by
    // the hook timeout) — keep the last frame from looking like a freeze by
    // saying the shutdown is in progress.
    this.state.footer.setTransientHint(SHUTTING_DOWN_HINT);
    this.state.ui.requestRender();
    // Restore the terminal even if closing the session / harness throws — a
    // SIGTERM during a network or MCP shutdown must not leave the user stuck in
    // raw mode with a hidden cursor.
    try {
      await this.closeSession('shutting down');
      this.clearQueuedMessages();
      this.staging.releaseAll();
      this.staging.deleteStaged(this.imageStore.clear());
      await this.staging.drain();
      await this.harness.close();
    } finally {
      removeForceExitListener();
      this.sessionEventHandler.stopAllMcpServerStatusSpinners();
      this.sessionEventHandler.clearStepRetryAttemptTimer();
      this.uninstallRainbowDance();
      try {
        await this.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.stopUiForExit();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // Ctrl+C while shutdown hooks run → skip the remaining graceful close. The
  // terminal is still alive (unlike the SIGHUP path), so run the full UI
  // teardown — alternate screen, mouse reporting, autowrap — and the CLI's
  // stty restore via onExit, instead of the bare emergency sequences.
  private forceExitDuringShutdown(): void {
    try {
      this.stopUiForExit();
    } catch {
      restoreTerminalModes();
    }
    if (this.onExit) {
      void this.onExit(130);
    } else {
      process.exit(130);
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

  private buildLayout(): void {
    const { ui } = this.state;
    // Fullscreen mounts its layout root (transcript ScrollView + bottom dock)
    // in createTUIState; the root children list stays empty there.
    if (ui instanceof TuiAltScreen) return;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.statusSurfaceContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
    ui.addChild(this.state.surveyContainer);
    ui.addChild(this.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    const dock = this.state.dockContainer;
    if (dock !== undefined) {
      // Dock sizing contract: the footer may shrink to 1 row under extreme
      // height pressure, but never disappears (see createTUIState).
      dock.addChild(footerWrap, { shrink: 1, minSize: 1 });
      return;
    }
    this.state.ui.addChild(footerWrap);
  }

  // Fullscreen exit: leave the alternate screen with the frame preserved,
  // then replay the transcript through a main-screen renderer so native
  // scrollback ends up with the same inline layout a regular session would
  // have produced (pi's "transcript" exit form).
  private stopUiForExit(): void {
    const ui = this.state.ui;
    if (!(ui instanceof TuiAltScreen)) {
      ui.stop();
      return;
    }
    ui.stop({ preserveScreen: true });
    const main = new TuiMainScreen(ui.terminal);
    main.addChild(this.state.transcriptContainer);
    main.addChild(this.state.activityContainer);
    main.addChild(this.state.statusSurfaceContainer);
    main.addChild(this.state.queueContainer);
    main.addChild(this.state.btwPanelContainer);
    main.addChild(this.state.surveyContainer);
    main.addChild(this.state.editorContainer);
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    main.addChild(footerWrap);
    // First paint of a main-screen renderer writes every line sequentially,
    // landing the whole transcript in native scrollback.
    main.renderNow();
    main.stop();
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleExclusiveModeLeave(mode: ActiveExclusiveMode): void {
    // Route through the same slash-command surface the mode was entered by, so
    // Shift-Tab and `/spec off` cannot drift apart. Swarm and tower are absent
    // by type: the cycle never leaves them, `/swarm off` and `/tower off` do.
    switch (mode) {
      case 'plan':
        void slashCommands.handlePlanCommand(this, 'off');
        return;
      case 'spec':
        void slashCommands.handleSpecCommand(this, 'off');
        return;
    }
  }

  handleExclusiveModeSwitch(mode: ReviewCycleMode): void {
    // Same routing rule as the leave path: the cycle reuses the slash-command
    // surface, so the engine keeps the final say on whether the mode is entered.
    switch (mode) {
      case 'plan':
        void slashCommands.handlePlanCommand(this, 'on');
        return;
      case 'spec':
        void slashCommands.handleSpecCommand(this, 'on');
        return;
    }
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.surveyController.notifyInputModeChanged(mode);
    this.updateEditorBorderHighlight();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === 'bash';
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = 'prompt';
      this.handleInputModeChange('prompt');
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError(t('tui.statusMessages.cannotSendWhileReplaying'));
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.messageDispatch.enqueueMessage(text, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this, text);
  }

  async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight (both inputs share the same creation promise);
      // honor the busy gate here, like handleUserInput does before the await,
      // instead of running the shell command concurrently with an agent turn.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.messageDispatch.enqueueMessage(command, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
    }
    // Echo the command locally (bash-input) with a `$` prompt. The agent also
    // records it for resume; this is the live view.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: currentTheme.fg('shellMode', `$ ${command}`),
      bullet: '',
    });
    // Create the live output entry up front. ShellRunComponent owns its own
    // rendering (running card → final view) and is mutated in place as output
    // streams in and on completion.
    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    };
    const outputComponent = new ShellRunComponent(() => this.state.ui.requestRender());
    // Inherit the current ctrl+o state, same as freshly mounted tool calls —
    // the global toggle only reaches components that exist when it fires.
    if (this.state.toolOutputExpanded) outputComponent.setExpanded(true);
    this.shellOutputStreams.set(commandId, { entry: outputEntry, component: outputComponent });
    this.appendTranscriptEntry(outputEntry, outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: 'shell' });
    this.state.ui.requestRender();

    this.track('shell_command');

    void session.runShellCommand(command, { commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(commandId, stdout, stderr, isError, backgrounded);
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, '', message, true);
        this.showError(t('tui.statusMessages.shellCommandFailed', { message }));
      },
    );
  }

  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? '';
    if (text.length === 0) return;
    stream.component.append(text);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    stream.taskId = event.taskId;
  }

  cancelRunningShellCommand(): void {
    const session = this.session;
    if (session === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.showError(
          t('tui.statusMessages.failedToCancelShellCommand', { error: formatErrorMessage(error) }),
        );
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
      // the UI and the model notification, so there is nothing to render here.
      return;
    }
    stream.component.finish(stdout, stderr, isError);
    // Keep the transcript entry's metadata in sync for anything that reads it
    // (export / copy). The component renders itself.
    stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
    this.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: 'idle' });
      this.drainOneQueuedMessage();
    }
  }

  private drainOneQueuedMessage(): void {
    const session = this.session;
    if (session === undefined) return;
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.updateQueueDisplay();
  }

  async sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    if (preExtracted === undefined) {
      // A just-pasted image/video may still be finishing its background
      // ingestion (compression/daemon upload): give it a bounded moment so
      // the submit can use the daemon-ref form — a slower image ingestion
      // extracts to the inline fallback instead, a slower video upload
      // refuses the submission below. Undefined when nothing is pending,
      // keeping the media-free send path synchronous.
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
    }
    try {
      // A cache-hint-swallowed resend passes its pre-dialog extraction back
      // in: the image store may already be cleared (e.g. after "Start a new
      // session"), so re-extracting from the text would lose the media.
      extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
      if (preExtracted !== undefined) {
        const parts = refreshExpiringImageFileRefs(
          extraction.parts,
          extraction.imageAttachmentIds,
          this.imageStore,
        );
        if (parts !== extraction.parts) extraction = { ...extraction, parts };
      }
    } catch (error) {
      // A pasted video's daemon upload was unusable (still in flight,
      // failed, expired); nothing was dispatched.
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    // Create the staging lease right after extraction, so every exit below
    // releases through the tracker instead of open-coding ids — a
    // forgotten exit degrades to an unclaimed lease (swept by `releaseAll`)
    // instead of a permanently retained upload. The lease carries the
    // exact-binding submission id: the consuming turn's `turn.started` echoes
    // it as `promptId`. A goal-active submission is steered and binds its
    // lease explicitly in sendMessageInternal, so it gets no id.
    const stagingLease = this.staging.create(
      // One retain per unique id per extraction: dedupe repeated placeholder
      // occurrences so the lease's id multiplicity matches the retain count.
      [...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds])],
      [],
      'user',
      extraction.hasMedia && this.state.appState.goal?.status !== 'active'
        ? randomUUID()
        : undefined,
    );
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.release(stagingLease);
      return;
    }
    // Idle cache-hint interception sits before session creation; it is
    // synchronous unless a hint actually fires. Aside from the bounded
    // ingestion wait above, the send path stays await-free up to sendMessage.
    if (this.cacheHint.maybeInterceptOnSubmit(text, extraction)) {
      // The stash owns the extraction from here: its resend re-leases inside
      // the re-entered send path, its restore goes through releaseRecalled
      // (see CacheHintController). Detach so the stash is not double-owned.
      this.staging.defer(stagingLease);
      return;
    }
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) {
        this.staging.release(stagingLease);
        return;
      }
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
        lease: stagingLease,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  async sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
  ): Promise<void> {
    if (this.btwPanelController.sendUserInput(text, activations)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const originatingSession = this.session;
    const mediaGeneration = this.imageStore.generation;
    let extraction: ExtractionResult;
    if (preExtracted === undefined) {
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
      if (
        (originatingSession !== undefined && this.session !== originatingSession) ||
        this.imageStore.generation !== mediaGeneration
      ) {
        this.showError('Session changed while preparing media attachment; skill prompt not sent.');
        return;
      }
    }
    try {
      extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
      if (
        preExtracted?.mediaGeneration !== undefined &&
        preExtracted.mediaGeneration !== this.imageStore.generation
      ) {
        extraction = { ...preExtracted, imageAttachmentIds: [], videoAttachmentIds: [] };
      }
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.releaseMedia([
        ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
      ], []);
      return;
    }
    if (this.cacheHint.maybeInterceptOnSubmit(text, extraction, activations)) return;
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) {
        this.staging.releaseMedia([
          ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
        ], []);
        return;
      }
    }
    if (
      this.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(text, {
        parts: extraction.hasMedia ? extraction.parts : undefined,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
        mediaSnapshots: extraction.mediaSnapshots,
        inlineSkillActivations: activations,
      });
      this.updateQueueDisplay();
      this.state.ui.requestRender();
      return;
    }
    this.beginSessionRequest();
    this.runInlineSkillActivations(session, text, activations, extraction);
  }

  prepareSkillActivations(
    activations: readonly InlineSkillActivation[],
    mediaSnapshots?: readonly MediaAttachment[],
  ): PreparedSkillActivations {
    const prepared: PreparedSkillActivations = {
      skills: [],
      mediaAttachmentIds: [],
      stagingPaths: [],
      cachedVideos: [],
    };
    try {
      for (const activation of activations) {
        if (activation.args === undefined) {
          prepared.skills.push({ name: activation.skillName });
          continue;
        }
        const rewrite = rewriteMediaPlaceholders(
          activation.args, this.imageStore, 'plain', mediaSnapshots,
        );
        this.imageStore.retainFileIds(rewrite.videoAttachmentIds);
        prepared.skills.push({ name: activation.skillName, args: rewrite.text });
        prepared.mediaAttachmentIds.push(
          ...new Set([...rewrite.imageAttachmentIds, ...rewrite.videoAttachmentIds]),
        );
        prepared.stagingPaths.push(...rewrite.stagingPaths);
        prepared.cachedVideos.push(...rewrite.cachedVideos);
      }
      return prepared;
    } catch (error) {
      this.releaseSkillArgumentMedia(prepared);
      throw error;
    }
  }

  releaseSkillArgumentMedia(prepared: PreparedSkillActivations): void {
    for (const id of prepared.mediaAttachmentIds) this.staging.releaseRecalled([id]);
    this.staging.releaseMedia([], prepared.stagingPaths);
  }

  private runInlineSkillActivations(
    session: Session,
    text: string,
    activations: readonly InlineSkillActivation[],
    extraction: ReturnType<typeof extractMediaAttachments>,
  ): void {
    let prepared: PreparedSkillActivations | undefined;
    let input: string | readonly PromptPart[];
    try {
      prepared = this.prepareSkillActivations(activations, extraction.mediaSnapshots);
      input = extraction.hasMedia
        ? resolveOriginalCaptions(
            omitExpiredVideoFileRefs(extraction.parts, prepared.cachedVideos),
            extraction.imageAttachmentIds,
            this.imageStore,
            originalsDirForSession(session),
          )
        : text;
    } catch (error) {
      if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
      this.staging.releaseMedia([
        ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
      ], []);
      this.failSessionRequest(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    const stagingLease = this.staging.create(
      [
        ...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds]),
        ...prepared.mediaAttachmentIds,
      ],
      prepared.stagingPaths,
      'user',
    );
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      skillNames: activations.map((activation) => activation.skillName),
      imageAttachmentIds:
        extraction.imageAttachmentIds.length > 0 ? extraction.imageAttachmentIds : undefined,
    });
    const request = session.promptWithSkills(input, prepared.skills);
    this.staging.trackDispatch(stagingLease, request, (error) => {
      if (this.session === session && stagingLease !== undefined && stagingLease.turnId === undefined) {
        this.staging.defer(stagingLease);
        for (const id of stagingLease.mediaAttachmentIds) this.staging.releaseRecalled([id]);
        this.staging.releaseMedia([], stagingLease.paths);
      }
      this.handleSkillActivationError(session, error);
    });
  }

  private handleSkillActivationError(session: Session, error: unknown): void {
    if (this.session !== session) return;
    const message = `Skill activation failed: ${formatErrorMessage(error)}`;
    if (this.streamingUI.getTurnContext().turnId === undefined) this.failSessionRequest(message);
    else this.showError(message);
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
    imageSnapshots?: readonly unknown[];
    mediaSnapshots?: readonly MediaAttachment[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      (extraction.imageAttachmentIds.length > 0 || (extraction.imageSnapshots?.length ?? 0) > 0) &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('Current model does not support image input.');
      return false;
    }
    if (
      (extraction.videoAttachmentIds.length > 0 ||
        extraction.mediaSnapshots?.some((snapshot) => snapshot.kind === 'video')) &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError('Current model does not support video input.');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    return this.messageDispatch.recallLastQueued();
  }

  recallStashedMedia(extraction: ExtractionResult | undefined): void {
    this.messageDispatch.recallStashedMedia(extraction);
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    return this.messageDispatch.sendNormalUserInput(text, preExtracted);
  }

  sendInlineSkillUserInput(
    text: string,
    options?: SendMessageOptions & {
      readonly inlineSkillActivations?: readonly InlineSkillActivation[];
    },
    mode?: 'prompt' | 'bash',
  ): QueuedMessage {
    return {
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
      mediaSnapshots: options?.mediaSnapshots,
      inlineSkillActivations: options?.inlineSkillActivations,
    };
  }

  beginSessionRequest(): void {
    this.messageDispatch.beginSessionRequest();
  }

  failSessionRequest(message: string): void {
    this.messageDispatch.failSessionRequest(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.runShellCommandFromInput(item.text);
      return;
    }
    if (item.inlineSkillActivations !== undefined && item.inlineSkillActivations.length > 0) {
      // Media was extracted and validated at enqueue time; reuse the queued
      // parts rather than re-extracting from a possibly-cleared image store.
      // Expiring daemon refs refresh at dispatch, same as the plain tail below.
      const refreshed =
        item.parts === undefined
          ? []
          : [
              ...refreshExpiringImageFileRefs(
                item.parts,
                item.imageAttachmentIds ?? [],
                this.imageStore,
              ),
            ];
      const extraction: ExtractionResult = {
        parts: refreshed,
        hasMedia: refreshed.length > 0,
        imageAttachmentIds: item.imageAttachmentIds !== undefined ? [...item.imageAttachmentIds] : [],
        videoAttachmentIds: item.videoAttachmentIds !== undefined ? [...item.videoAttachmentIds] : [],
        imageSnapshots: [],
        mediaSnapshots: item.mediaSnapshots,
      };
      this.beginSessionRequest();
      this.runInlineSkillActivations(session, item.text, item.inlineSkillActivations, extraction);
      return;
    }
    const parts =
      item.parts === undefined
        ? undefined
        : refreshExpiringImageFileRefs(
            item.parts,
            item.imageAttachmentIds ?? [],
            this.imageStore,
          );
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts,
        imageAttachmentIds: item.imageAttachmentIds,
        videoAttachmentIds: item.videoAttachmentIds,
      });
    });
  }

  handleTurnStarted(event: TurnStartedEvent): void {
    this.staging.handleTurnStarted(event);
    this.surveyController.notifyTurnStarted(isUserSubmittedTurnOrigin(event.origin));
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    this.staging.handleTurnEnded(event);
    this.surveyController.notifyTurnEnded(event.traceId);
  }

  releaseStagingMedia(mediaAttachmentIds: readonly number[]): void {
    this.staging.releaseMedia(mediaAttachmentIds, []);
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });
    // A goal-active steer is buffered into the running goal turn — no new
    // turn.started will fire for handleTurnStarted to claim the lease — so
    // bind it to that turn here. The turn context must be read BEFORE
    // beginSessionRequest resets it, and only while a turn is actually live
    // (finalizeTurn clears the id at turn end; a queued dispatch can land
    // while the goal driver's next continuation turn is already streaming).
    const runningTurnId =
      this.state.appState.streamingPhase === 'idle' || this.state.appState.streamingPhase === 'shell'
        ? undefined
        : this.streamingUI.getTurnContext().turnId;
    this.beginSessionRequest();

    // Compression captions for pasted images are authored here — not at
    // extraction — because only now is the session (and its media-originals
    // dir) known: extraction runs before a first session exists.
    const sdkInput =
      options?.parts !== undefined
        ? resolveOriginalCaptions(
            options.parts,
            options.imageAttachmentIds ?? [],
            this.imageStore,
            originalsDirForSession(session),
          )
        : input;
    const goalActive = this.state.appState.goal?.status === 'active';
    // The lease normally arrives pre-created by sendNormalUserInput (carrying
    // its exact-binding submission id). Queued dispatches and steer batches
    // arrive with raw ids instead: a prompt submission carrying staged
    // media gets a client-chosen prompt id minted here — the engine echoes it
    // on the consuming turn's `turn.started` (`promptId`), so the lease binds
    // exactly instead of through the origin heuristic. The goal-steer path
    // binds its lease explicitly below, so it gets no id.
    const stagingIds = [
      ...(options?.imageAttachmentIds ?? []),
      ...(options?.videoAttachmentIds ?? []),
    ];
    const stagingLease =
      options?.lease ??
      this.staging.create(
        // One retain per unique id per extraction: dedupe repeated placeholder
        // occurrences so the lease's id multiplicity matches the retain count.
        [...new Set(stagingIds)],
        [],
        'user',
        !goalActive && stagingIds.length > 0 ? randomUUID() : undefined,
      );
    const submissionId = stagingLease?.submissionId;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (goalActive) {
      if (runningTurnId !== undefined) this.staging.bindToTurn(stagingLease, runningTurnId);
      this.staging.trackDispatch(stagingLease, session.steer(sdkInput), (error) => {
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(`Failed to steer: ${formatErrorMessage(error)}`);
      });
      return;
    }
    this.staging.trackDispatch(stagingLease, session.prompt(sdkInput, { promptId: submissionId }), (error) => {
      this.failSessionRequest(`Failed to send: ${formatErrorMessage(error)}`);
    });
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, 'tag');
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    const stagingLease = this.staging.create(
      [...new Set(rewrite.imageAttachmentIds)],
      rewrite.stagingPaths,
      'plugin_command',
    );
    if (!this.validateMediaCapabilities(rewrite)) {
      this.staging.release(stagingLease);
      return;
    }
    this.beginSessionRequest();
    this.staging.trackDispatch(
      stagingLease,
      session.activatePluginCommand(pluginId, commandName, rewrite.text),
      (error) => {
        this.failSessionRequest(
          `Command "${pluginId}:${commandName}" failed: ${formatErrorMessage(error)}`,
        );
      },
    );
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    // Submission order must survive a mid-turn compaction: objectives queued
    // while compacting stay queued when the turn outlives the compaction, so
    // steering this input ahead of them would reorder the conversation.
    // Prompt-only backlog rides along in the same steer batch, ahead of the
    // new input; a non-steerable backlog (bash, slash-skill, inline-skill
    // bundle) cannot, and then this input queues behind it instead.
    if (
      this.canSteerQueueIntoRunningTurn() &&
      this.state.queuedMessages.every(isSteerableQueuedMessage)
    ) {
      // Same lease hand-off as the queue path below: the pre-dispatch lease
      // defers to the raw ids on the queue item, which re-leases inside
      // steerMessage and binds to the running turn.
      this.staging.defer(options?.lease);
      this.state.queuedMessages.push(this.toQueuedMessage(input, options));
      this.updateQueueDisplay();
      this.steerQueuedMessagesIntoRunningTurn();
      return;
    }
    if (
      this.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      // A queued message re-leases its staged media at dequeue dispatch; the
      // pre-dispatch lease defers to the queue item's raw ids.
      this.staging.defer(options?.lease);
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  // Tower mode keeps the main agent as a long-lived coordinator: while its
  // turn is live, input steers into that turn instead of queueing behind it,
  // so consecutive /tower objectives are accepted immediately rather than
  // serialized one turn at a time. A running WaitFor steers the same way: the
  // steer ends the wait at once and the model reads the new input, instead of
  // the input queueing until the wait times out. A foreground shell command
  // ('shell') has no turn to steer into and keeps queue semantics, as do
  // input deferral and compaction.
  private canSteerQueueIntoRunningTurn(): boolean {
    const phase = this.state.appState.streamingPhase;
    return (
      (this.state.appState.towerMode || this.streamingUI.isWaitForRunning()) &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      !this.deferUserMessages &&
      !this.state.appState.isCompacting
    );
  }

  steerQueuedMessagesIntoRunningTurn(manual = false): void {
    const session = this.session;
    if (session === undefined || this.steeringQueuedMessages.size > 0) return;
    if (manual ? !this.canManuallySteer() : !this.canSteerQueueIntoRunningTurn()) return;
    const batch = manual
      ? this.state.queuedMessages.filter((message) => message.mode !== 'bash')
      : [...this.state.queuedMessages];
    if (batch.length === 0 || (!manual && !batch.every(isSteerableQueuedMessage))) return;
    const pending = [...batch];
    const sendNext = (): void => {
      if (this.deferUserMessages || this.state.appState.isCompacting) return;
      let first = pending.shift();
      while (first !== undefined && !this.state.queuedMessages.includes(first)) first = pending.shift();
      if (first === undefined) {
        this.updateQueueDisplay();
        if (!manual && this.canSteerQueueIntoRunningTurn()) {
          this.steerQueuedMessagesIntoRunningTurn();
        } else {
          this.drainQueueIfIdle();
        }
        return;
      }
      const group = [first];
      if (first.inlineSkillActivations === undefined) {
        while (pending[0] !== undefined && pending[0].inlineSkillActivations === undefined) {
          const next = pending.shift()!;
          if (this.state.queuedMessages.includes(next)) group.push(next);
        }
      }
      for (const message of group) this.steeringQueuedMessages.add(message);
      this.updateQueueDisplay();
      const items = group.map((message) => {
        const item = toSteerInputItem(message);
        if (message.parts === undefined) return item;
        return {
          ...item,
          parts: refreshExpiringImageFileRefs(
            message.parts,
            message.imageAttachmentIds ?? [],
            this.imageStore,
          ),
        };
      });
      this.steerMessage(session, items, (steered) => {
        for (const message of group) this.steeringQueuedMessages.delete(message);
        if (this.session !== session) return;
        if (steered || manual) {
          const done = new Set(group);
          this.state.queuedMessages = this.state.queuedMessages.filter((message) => !done.has(message));
        }
        if (!steered) {
          this.staging.releaseQueued(group.filter((message) => !this.state.queuedMessages.includes(message)));
        }
        this.updateQueueDisplay();
        if (steered || manual) sendNext();
        else this.drainQueueIfIdle();
      }, manual);
    };
    sendNext();
  }

  canManuallySteer(): boolean {
    const phase = this.state.appState.streamingPhase;
    return (
      !this.deferUserMessages &&
      !this.state.appState.isCompacting &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      this.steeringQueuedMessages.size === 0
    );
  }

  isSteeringQueuedMessages(): boolean {
    return this.steeringQueuedMessages.size > 0;
  }

  private drainQueueIfIdle(): void {
    if (
      this.state.appState.streamingPhase !== 'idle' ||
      this.deferUserMessages ||
      this.state.appState.isCompacting ||
      this.state.queuedMessageDispatchPending
    ) {
      return;
    }
    this.drainOneQueuedMessage();
  }

  steerMessage(
    session: Session,
    input: readonly SteerInputItem[],
    onSettled?: (steered: boolean) => void,
    manual = false,
  ): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      if (onSettled !== undefined) {
        onSettled(false);
      } else {
        for (const item of input) this.enqueueMessage(item.text, item);
      }
      return;
    }
    const activations = input.flatMap((item) => item.inlineSkillActivations ?? []);
    let prepared: PreparedSkillActivations | undefined;
    let resolvedInput: readonly SteerInputItem[];
    try {
      if (activations.length > 0) {
        prepared = this.prepareSkillActivations(
          activations,
          input.some((item) => item.mediaSnapshots !== undefined)
            ? input.flatMap((item) => item.mediaSnapshots ?? [])
            : undefined,
        );
      }
      resolvedInput = input.map((item) =>
        item.parts === undefined
          ? item
          : {
              ...item,
              parts: resolveOriginalCaptions(
                prepared === undefined ? item.parts : omitExpiredVideoFileRefs(item.parts, prepared.cachedVideos),
                item.imageAttachmentIds ?? [],
                this.imageStore,
                originalsDirForSession(session),
              ),
            },
      );
    } catch (error) {
      if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      onSettled?.(false);
      return;
    }
    const startsNewTurn = this.state.appState.streamingPhase === 'idle';
    if (startsNewTurn) this.beginSessionRequest();
    const steeredEntries: TranscriptEntry[] = input.map((item) => ({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: this.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: item.text,
      skillNames: item.inlineSkillActivations?.map((activation) => activation.skillName),
      imageAttachmentIds:
        item.imageAttachmentIds !== undefined && item.imageAttachmentIds.length > 0
          ? item.imageAttachmentIds
          : undefined,
    }));
    for (const entry of steeredEntries) this.appendTranscriptEntry(entry);
    const mediaAttachmentIds = input.flatMap((item) => [
      ...new Set([...(item.imageAttachmentIds ?? []), ...(item.videoAttachmentIds ?? [])]),
    ]);
    const stagingLease = this.staging.create(
      [...mediaAttachmentIds, ...(prepared?.mediaAttachmentIds ?? [])],
      prepared?.stagingPaths ?? [],
      'user',
    );
    const currentTurnId = this.streamingUI.getTurnContext().turnId;
    // Skill steers may not merge into the current turn: an untracked active
    // turn (e.g. a goal continuation) has no steerable prompt, so the engine
    // queues the submission — and binding the lease here would release its
    // media when that unrelated turn ends. Leave skill leases unclaimed so
    // the submission's own turn.started claims them; a merged steer simply
    // retires its media at session close instead.
    if (currentTurnId !== undefined && prepared === undefined) this.staging.bindToTurn(stagingLease, currentTurnId);
    const request = prepared === undefined
      ? session.steer(combineSteerInput(resolvedInput))
      : session.promptWithSkills(
          combineSteerInput(resolvedInput),
          prepared.skills,
          { steerIfActive: true },
        );
    if (onSettled !== undefined) {
      void request.then(
        () => onSettled(true),
        () => {},
      );
    }
    this.staging.trackDispatch(stagingLease, request, (error) => {
      if (this.session !== session) {
        onSettled?.(false);
        return;
      }
      const message = `Failed to steer: ${formatErrorMessage(error)}`;
      if (startsNewTurn && this.streamingUI.getTurnContext().turnId === undefined) {
        this.failSessionRequest(message);
      } else {
        this.showError(message);
      }
      if (onSettled !== undefined) {
        this.staging.defer(stagingLease);
        if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
        if (prepared === undefined && !manual) this.removeTranscriptEntries(steeredEntries);
        onSettled(false);
      }
    });
  }

  private removeTranscriptEntries(entries: readonly TranscriptEntry[]): void {
    const doomed = new Set(entries);
    const componentsToRemove = this.state.transcriptContainer.children.filter((child) => {
      const entry = getTranscriptComponentEntry(child);
      return entry !== undefined && doomed.has(entry);
    });
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }
    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !doomed.has(e));
    this.state.ui.requestRender();
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    const queued = this.state.queuedMessages;
    this.state.queuedMessages = [];
    this.staging.releaseQueued(queued.filter((message) => !this.steeringQueuedMessages.has(message)));
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.steeringQueuedMessages.size > 0) return undefined;
    return this.state.queuedMessages.shift();
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
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
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const additionalDirsChanged =
      'additionalDirs' in patch &&
      !sameStringArrays(this.state.appState.additionalDirs, patch.additionalDirs ?? []);
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    const reviewModeChanged =
      'planMode' in patch || 'specMode' in patch || 'swarmMode' in patch || 'towerMode' in patch;
    Object.assign(this.state.appState, patch);
    if (reviewModeChanged) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (additionalDirsChanged) this.setupAutocomplete();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  private syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.state.appState.additionalDirs, additionalDirs)) return;
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
   * no session exists. Runs at session-less startup and again on /reload
   * while still session-less, so externally edited defaults take effect
   * before the first lazy-created session.
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
      // Reset to manual when the default was removed from config — a stale
      // elevated mode must not be passed to the first lazy-created session.
      patch.permissionMode = config.defaultPermissionMode ?? 'manual';
    }
    // Track the config default itself (vs an explicit CLI --plan) so the lazy
    // create path can tell which one would activate plan mode; a removed
    // default also clears the hydrated footer value.
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
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(getLlmNotSetMessage());
    }
    // With an active session, carry the live plan state. Session-less (lazy
    // creation / `/new` before the first session) on v2, pass only the
    // explicit CLI --plan intent — and only when the engine is not already
    // applying `defaultPlanMode` at create time (sessionLifecycleService),
    // since re-entering an active plan mode throws.
    const explicitPlanMode =
      this.session !== undefined
        ? this.state.appState.planMode
        : this.options.startup.plan && this.state.appState.configDefaultPlanMode !== true;
    const options: MutableCreateSessionOptions = {
      workDir: this.state.appState.workDir,
      model,
      // With an active session, carry the live effort. Session-less (lazy
      // creation / `/new` before the first session), carry the session-only
      // thinking override chosen via Alt+S if any — never the initial 'off'
      // default, which would force thinking off where the engine's config or
      // model default would apply.
      thinking:
        this.session === undefined
          ? this.state.appState.lazySessionThinking
          : this.state.appState.thinkingEffort,
      permission: this.state.appState.permissionMode,
      planMode: explicitPlanMode ? true : undefined,
    };
    if (this.state.appState.additionalDirs.length > 0) {
      options.additionalDirs = [...this.state.appState.additionalDirs];
    }
    if (bindStartupAgent) {
      // The --agent/--agent-file startup binding is consumed by the first
      // lazy-created session; `/new` sessions fall back to the default profile.
      if (this.state.appState.agentProfile !== undefined) {
        options.agentProfile = this.state.appState.agentProfile;
      }
      if (this.state.appState.agentFiles !== undefined) {
        options.agentFiles = [...this.state.appState.agentFiles];
      }
    }
    return this.harness.createSession(options);
  }

  /**
   * Lazy-create the session on first use (v2 engine, session-less startup).
   * Returns the existing session, or creates one from the current state and
   * runs the same assembly `createNewSession` performs. Returns undefined and
   * shows the error when creation fails; callers must still guard on
   * `appState.model`.
   *
   * Concurrent first-use triggers (a double Enter, or a slash command right
   * after a prompt) both observe `session === undefined`, so the first caller
   * owns the creation and the rest share the in-flight promise — otherwise
   * two sessions would be created and the later `setSession` would close the
   * first one mid-dispatch.
   */
  async ensureSession(): Promise<Session | undefined> {
    // Even when a session is already assigned, a previous lazy creation may
    // still be finishing its assembly (runtime sync, command refresh,
    // subscription). Wait for it so callers never dispatch against a
    // partially initialized session.
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
      this.showError(t('tui.statusMessages.failedToStartSession', { message: msg }));
      return undefined;
    }
    this.resetSessionRuntime();
    await this.setSession(session, 0);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(t('tui.statusMessages.postCreateSetupFailed', { message: msg }));
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
    if (this.state.appState.lazySessionThinking !== undefined) {
      this.setAppState({ lazySessionThinking: undefined });
    }
    return session;
  }

  async setSession(
    session: Session,
    initialUserTurnCount = session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount,
  ): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    // A session switch abandons the previous session's in-flight staging
    // leases and retires its history-owned cache copies. Do this at the
    // boundary so retired paths cannot accumulate until process shutdown.
    // Only when actually replacing a live session, though: on lazy first
    // creation the outstanding lease belongs to the new session's first
    // prompt, whose dispatch continues right after this — releasing it here
    // would delete the staged media (e.g. a pasted image's daemon upload)
    // before the engine's intake can read it.
    if (previous !== undefined) this.staging.releaseAll();
    this.session = session;
    this.surveyController.seedUserTurnCount(initialUserTurnCount);
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
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
      specMode: status.specMode ?? false,
      specStage: status.specStage,
      swarmMode: status.swarmMode ?? false,
      towerMode: status.towerMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      cumulativeTokens: status.usage?.total === undefined ? 0 : sumTokenUsage(status.usage.total),
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
    this.syncAdditionalDirs(session);
  }

  // Apply --auto/--yolo/--plan startup flags to a resumed session. The resumed
  // session may already be in plan mode from its persisted records, and
  // re-entering plan mode throws, so only enable it when it is not active yet.
  // setPermission is idempotent and needs no such guard.
  async applyStartupModesToResumedSession(session: Session): Promise<void> {
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
  // syncRuntimeState and session-replay hydration can both read stale persisted
  // values, so this guarantees the footer reflects the CLI intent.
  applyStartupPermissionAndPlanToAppState(): void {
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
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
    this.staging.releaseAll();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.state.swarmModeEntry = undefined;
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
        this.transcriptRenderer.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.state.sessionsScope): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    this.state.sessionsNextCursor = undefined;
    this.state.sessionsLoadingMore = false;
    try {
      const page = await this.harness.listSessionsPage({
        workDir: scope === 'all' ? undefined : this.state.appState.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
      });
      this.state.sessionsNextCursor = page.nextCursor;
      this.state.sessions = sessionRowsForPicker(
        page.items,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn('failed to fetch sessions for picker', { error: String(error) });
    } finally {
      this.state.loadingSessions = false;
    }
  }

  /**
   * Pulls the next keyset page into the session picker (scroll-bottom paging).
   * A scope switch or picker close bumps `sessionPickerScopeRequestToken`,
   * which makes an in-flight append discard its result. Returns whether a page
   * was appended — callers draining pages stop on the first `false`.
   * Scroll triggers pass no argument and are dropped while a fetch is running;
   * the search drain passes `waitForInFlight` to join the running fetch and
   * continue with the next page, so a query typed mid-fetch still ends up
   * covering every session.
   */
  async fetchMoreSessions(waitForInFlight = false): Promise<boolean> {
    while (this.sessionsPageFetchInFlight !== undefined) {
      if (!waitForInFlight) return false;
      await this.sessionsPageFetchInFlight;
    }
    const cursor = this.state.sessionsNextCursor;
    if (cursor === undefined) return false;
    const requestToken = this.dialogController.sessionPickerRequestToken;
    this.state.sessionsLoadingMore = true;
    this.dialogController.setSessionPickerPaging(true, true);
    this.state.ui.requestRender();
    const run = this.appendNextSessionPage(cursor, requestToken);
    this.sessionsPageFetchInFlight = run;
    try {
      return await run;
    } finally {
      if (this.sessionsPageFetchInFlight === run) this.sessionsPageFetchInFlight = undefined;
    }
  }

  private async appendNextSessionPage(cursor: string, requestToken: number): Promise<boolean> {
    try {
      const page = await this.harness.listSessionsPage({
        workDir: this.state.sessionsScope === 'all' ? undefined : this.state.appState.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
        before: cursor,
      });
      if (requestToken !== this.dialogController.sessionPickerRequestToken) return false;
      this.state.sessionsNextCursor = page.nextCursor;
      const rows = sessionRowsForPicker(
        page.items,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
      this.state.sessions = [...this.state.sessions, ...rows];
      this.dialogController.appendSessionPickerRows(rows);
      this.dialogController.setSessionPickerPaging(page.nextCursor !== undefined, false);
      return true;
    } catch (error) {
      log.warn('failed to fetch more sessions for picker', { error: String(error) });
      return false;
    } finally {
      if (requestToken === this.dialogController.sessionPickerRequestToken) {
        this.state.sessionsLoadingMore = false;
        this.dialogController.setSessionPickerPaging(
          this.state.sessionsNextCursor !== undefined,
          false,
        );
        this.state.ui.requestRender();
      }
    }
  }

  /**
   * Search covers every session: while a query is active the picker asks for
   * all remaining pages, drained one at a time in the background. A failed or
   * superseded fetch stops the drain (the next fresh query re-triggers it).
   */
  async drainSessionsForSearch(): Promise<void> {
    const requestToken = this.dialogController.sessionPickerRequestToken;
    while (
      this.state.sessionsNextCursor !== undefined &&
      requestToken === this.dialogController.sessionPickerRequestToken
    ) {
      if (!(await this.fetchMoreSessions(true))) return;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.cacheHint.resetRuntime();
    this.resetTokenSpeed();
    this.surveyController.reset();
    this.streamingUI.discardPending();
    this.clearQueuedMessages();
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.sessionEventHandler.notifications.clear();
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = t('tui.statusMessages.resumeOtherWorkDir', { command });
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  ${t('tui.messages.sessionForkCommandCopied')}`, 'warning');
    } catch {
      this.showStatus(`${message}\n  ${t('tui.messages.sessionForkCommandCopyFailed')}`, 'warning');
    }
  }

  async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state — the pending prompt would otherwise
    // replace the resumed session when creation completes.
    await this.waitForLazyCreation();
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus(t('tui.statusMessages.alreadyOnSession'));
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError(t('tui.statusMessages.cannotSwitchWhileStreaming'));
      return false;
    }
    if (this.state.appState.isReplaying) {
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
      this.showError(
        t('tui.statusMessages.failedToResumeSession', {
          sessionId: targetSessionId,
          message: msg,
        }),
      );
      return false;
    }

    await this.switchToSession(
      session,
      t('tui.statusMessages.resumedSession', { sessionId: session.id }),
    );
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
    this.transcriptRenderer.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(t('tui.statusMessages.replayFailed', { message: msg }));
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(
        t('tui.statusMessages.warningPrefix', { message: resumeState.warning }),
        'warning',
      );
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
    this.surveyController.seedUserTurnCount(
      session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount,
    );
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
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(
        t('tui.statusMessages.warningPrefix', { message: resumeState.warning }),
        'warning',
      );
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError(t('tui.statusMessages.cannotStartNewWhileReplaying'));
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(t('tui.statusMessages.failedToStartNewSession', { message: msg }));
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session, 0);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(t('tui.statusMessages.postCreateSetupFailed', { message: msg }));
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    this.transcriptRenderer.clearTranscriptAndRedraw();
    this.showStatus(t('tui.statusMessages.startedNewSession', { sessionId: session.id }));
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

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        const skillNames = new Set(entry.skillNames);
        for (const [command, skillName] of this.skillCommandMap) {
          if (entry.skillNames?.includes(skillName)) skillNames.add(command.replace(/^skill:/, ''));
        }
        return new UserMessageComponent(entry.content, images, entry.bullet, [...skillNames]);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'plugin_command': {
        const data = entry.pluginCommandData;
        if (data === undefined) return null;
        return new PluginCommandComponent(data.pluginId, data.commandName, data.args);
      }
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.content.trimStart().startsWith('✓ Goal complete')) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  mountTranscriptComponent(entry: TranscriptEntry, component: Component): void {
    this.transcriptRenderer.mountTranscriptComponent(entry, component);
  }

  replaceTranscriptChild(
    previous: Component,
    next: Component,
    entry?: TranscriptEntry,
  ): boolean {
    return this.transcriptRenderer.replaceTranscriptChild(previous, next, entry);
  }

  removeTranscriptEntries(entries: readonly TranscriptEntry[]): void {
    this.transcriptRenderer.removeTranscriptEntries(entries);
  }

  mergeCurrentTurnSteps(): boolean {
    return this.transcriptRenderer.mergeCurrentTurnSteps();
  }

  mergeCompletedTurnAssistants(): boolean {
    return this.transcriptRenderer.mergeCompletedTurnAssistants();
  }

  mergeAllTurnSteps(): void {
    this.transcriptRenderer.mergeAllTurnSteps();
  }

  showStatus(message: string, color?: ColorToken): void {
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: message,
      color,
    });
  }

  showNotice(title: string, detail?: string): void {
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'notice',
      content: title,
      detail,
    });
  }

  showError(message: string): void {
    this.showStatus(t('tui.statusMessages.errorPrefix', { message }), 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    // Ownership: MoonLoader arms nothing by itself; this returned handle starts
    // the frames and the `stop()` below is what ends them.
    spinner.start();
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: label,
    };
    // The spacer is chrome for the spinner; both carry the same entry so the
    // transcript bookkeeping attributes them to one row group.
    this.mountTranscriptComponent(entry, new Spacer(1));
    this.appendTranscriptEntry(entry, spinner);
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        entry.content = `${symbol} ${finalLabel}`;
        spinner.setText(currentTheme.fg(tone, entry.content));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        entry.content = nextLabel;
        spinner.setLabel(nextLabel);
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.appendTranscriptEntry(
      {
        id: nextTranscriptId(),
        kind: 'status',
        turnId: undefined,
        renderMode: 'plain',
        content: auth.verificationUriComplete,
      },
      new DeviceCodeBoxComponent({
        title: t('tui.chrome.deviceCodeBox.title'),
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: t('tui.chrome.deviceCodeBox.hint'),
      }),
    );
    return this.showLoginProgressSpinner(t('tui.statusMessages.waitingForAuthorization'));
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes: waiting/tool
    // share the moon kind and thinking/composing share the braille kind, so a
    // burst of tool calls or thinking/composing alternation does not flip
    // tips. Clear the cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm = this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    // Carry the retry state in the mode key so an incoming/cleared
    // `turn.step.retrying` rebuilds the waiting pane with fresh label and
    // detail instead of hitting the cached-pane early return below.
    const retry = effectiveMode === 'waiting' ? this.state.appState.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? 'swarm' : 'pane'}:${retryKey}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(this.state.activitySpinner?.instance);
      }
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const stepRetry = this.state.appState.stepRetry;
        const spinner = this.ensureActivitySpinner('moon', waitingSpinnerLabel(stepRetry));
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: stepRetry === null ? this.currentLoadingTip?.tip : undefined,
            detail: stepRetry === null ? undefined : formatStepRetryDetail(stepRetry),
          }),
        );
        break;
      }
      case 'thinking': {
        const spinner = this.ensureActivitySpinner('braille', 'Working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'thinking',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'Working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Working modes occupy two rows (a spacer above the loader); idle
        // keeps a one-row placeholder so the dock only shifts once at turn
        // boundaries instead of on every intra-turn mode flip.
        this.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.deferUserMessages && !this.isSteeringQueuedMessages(),
        terminalRows: () => this.state.terminal.rows,
      }),
    );
  }

  /**
   * Index of the first transcript child ctrl+o may expand: a component is
   * expandable only if it sits at or after the start of the
   * (totalTurns - expandTurns)-th turn, i.e. it belongs to one of the most
   * recent `expandTurns` turns. Position-based so it also covers streaming
   * components that have no entry in the metadata map.
   */
  private expandCutoff(children: readonly Component[]): number {
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.transcriptRenderer.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    return expandCutoffIndex(children.length, boundaries, TRANSCRIPT_EXPAND_TURNS);
  }

  /**
   * What the footer's ctrl+o hint should offer: `expand` while a card in the
   * expandable window keeps content out of its collapsed form, `collapse`
   * once the toggle shows it, `null` when ctrl+o would change nothing.
   */
  private toolOutputExpandHint(): 'expand' | 'collapse' | null {
    const children = this.state.transcriptContainer.children;
    if (this.state.toolOutputExpanded) {
      // Toggling off collapses every expanded card, including one that slid
      // out of the expansion window since it was expanded, so any expanded
      // card with hidden content keeps the collapse hint on.
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (isExpandedComponent(child) && countedByExpandHint(child)) return 'collapse';
      }
      return null;
    }
    const cutoff = this.expandCutoff(children);
    for (let i = children.length - 1; i >= cutoff; i--) {
      if (countedByExpandHint(children[i])) return 'expand';
    }
    return null;
  }

  private toggleClickedFoldBlock(index: number): TuiMouseEventResult | undefined {
    const children = this.state.transcriptContainer.children;
    const hit = children[index];
    if (hit === undefined || !isExpandable(hit) || !hasHiddenContent(hit)) return undefined;
    if (isExpandedComponent(hit)) {
      hit.setExpanded(false);
    } else if (index >= this.expandCutoff(children)) {
      hit.setExpanded(true);
    } else {
      return undefined;
    }
    this.state.ui.requestRender();
    return { handled: true };
  }

  /**
   * Fold/unfold a single-child panel row through the `Expandable` capability.
   *
   * Kept next to `toggleClickedFoldBlock` so the two click-to-fold paths read as
   * one rule with two hosts. There is no expand window here: the panels row is
   * always current, so a fold is allowed in both directions.
   */
  private togglePanelsRowFold(): TuiMouseEventResult | undefined {
    const hit = this.state.notifyPanelContainer.children[0];
    // `isExpandable` is the predicate that narrows; `isExpandedComponent` only
    // answers yes/no, so it is used for the query and this one for the type.
    if (hit === undefined || !isExpandable(hit)) return undefined;
    if (isExpandedComponent(hit)) {
      hit.setExpanded(false);
    } else if (hasHiddenContent(hit)) {
      hit.setExpanded(true);
    } else {
      return undefined;
    }
    this.state.ui.requestRender();
    return { handled: true };
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;
    const expandCutoff = this.expandCutoff(children);

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.state.ui.requestRender();
  }

  /**
   * Fold or unfold whatever the strip is showing. Returns false when folding
   * would change nothing, which the editor uses to fall through to its own
   * Ctrl+T binding instead of swallowing the key.
   *
   * Routed through the surface rather than naming the todo region, because the
   * surface already resolves this as "the focused region, else the todo list".
   * Calling `toggleFold('todo')` directly left a pending approval's folded
   * prompt with no key that could open it: the region advertises a `toggle`
   * handler and the surface routes `toggle` to it, but this entry point never
   * asked.
   */
  toggleTodoPanelExpansion(): boolean {
    if (!this.state.statusSurface.handleKey('toggle')) return false;
    this.state.ui.requestRender();
    return true;
  }

  /**
   * Move the keyboard into the status strip's declared focus region, or release
   * it. Which region that is belongs to the region, not to this host.
   */
  toggleStatusSurfaceFocus(): boolean {
    return this.sessionEventHandler.notifications.toggleFocus();
  }

  handleStatusSurfaceKey(key: StatusSurfaceKey): boolean {
    if (key === 'focus') return this.toggleStatusSurfaceFocus();
    return this.state.statusSurface.handleStatusSurfaceKey(key);
  }

  handleStatusSurfaceRawInput(data: string): boolean {
    return this.state.statusSurface.handleRawInput(data);
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint(t('tui.messages.kimiTuiNoShellCommand'));
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint(t('tui.messages.kimiTuiCommandStarting'));
      return;
    }
    const session = this.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint(t('tui.messages.kimiTuiCommandFinished'));
        return;
      }
    } catch (error) {
      this.showError(
        t('tui.messages.kimiTuiMoveToBackgroundFailed', {
          error: formatErrorMessage(error),
        }),
      );
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = t('tui.messages.shellRun.backgrounded');
    this.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by the engine via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
    this.showDetachHint(t('tui.messages.kimiTuiMovedToBackground'));
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
      this.showError(
        t('tui.messages.kimiTuiListTasksFailed', { error: formatErrorMessage(error) }),
      );
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint(t('tui.messages.kimiTuiNoForegroundTask'));
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
        this.showError(
          t('tui.messages.kimiTuiDetachFailed', {
            taskId: target.taskId,
            error: formatErrorMessage(error),
          }),
        );
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
          : t('tui.messages.kimiTuiMovedTasksToBackground', { count: String(detached) });
    } else {
      hint = t('tui.messages.kimiTuiMovedSomeTasksToBackground', {
        count: String(detached),
        total: String(targets.length),
      });
    }
    if (detached > 0) hint = t('tui.messages.kimiTuiTasksToView', { hint });
    this.showDetachHint(hint);
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === 'bash';
    // Every mode that constrains what may be written highlights the border, not
    // just plan — otherwise spec/swarm/tower sessions give no visual signal.
    const highlighted = editorBorderHighlighted(this.state.appState, isBash, trimmed);
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; review-mode and slash context stay primary.
    const borderToken = isBash ? 'shellMode' : highlighted ? 'primary' : 'border';
    this.state.editor.borderColor = (s: string) => currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  /**
   * Live pre-send warning in the footer while the typed `/goal` objective
   * exceeds the length limit, so the user can trim it (or move it into a
   * file) before submitting instead of losing the input to a rejection.
   * `undefined` input means the text cannot be a `/goal` command and is not
   * measured at all. The footer keeps this warning in its own slot, so
   * transient hints (exit confirm, detach, image paste) only displace it
   * temporarily.
   */
  updateGoalLengthWarning(text: string | undefined): void {
    const warning = text === undefined ? undefined : goalObjectiveLengthWarning(text);
    this.state.footer.setWarningHint(warning ?? null);
    this.state.ui.requestRender();
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const { palette, resolved: applied } = await getColorPalette(
      themeName === 'auto' ? (resolved ?? 'dark') : themeName,
    );
    currentTheme.setPalette(palette, applied);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      void this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette, resolved);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void {
    this.surveyController.notifyDisplaced();
    this.dialogController.mountEditorReplacement(panel, onDisplaced);
  }

  restoreEditor(): void {
    this.dialogController.restoreEditor();
  }

  /**
   * Toggle the editor's in-flight rewrite signal.
   *
   * The flag lives on the editor so it survives the border repaints that typing
   * triggers mid-request (see `CustomEditor.optimizing`); this only has to flip
   * it and ask for a frame.
   */
  setEditorOptimizing(optimizing: boolean): void {
    if (this.state.editor.optimizing === optimizing) return;
    this.state.editor.optimizing = optimizing;
    this.state.ui.requestRender();
  }

  restoreInputText(text: string): void {
    this.dialogController.restoreInputText(text);
  }

  /** Latest in-process LLM round-trip; feeds the idle cache-hint scenario. */
  recordSessionActivity(): void {
    this.cacheHint.recordActivity();
  }

  /** Per-step usage for the client-side cache-break detector. */
  noteStepUsage(usage: TokenUsage | undefined): void {
    this.cacheHint.noteStepUsage(usage);
  }

  /**
   * Per-step cache-hit accounting for the footer readout, and the close of the
   * step's decode window. Cache hit/miss input tokens accumulate for the live
   * hit rate; the two speed samples — the step just closed and the session so
   * far — come from `usage.output` over the window the engine measured between
   * the step's first and last token-bearing parts.
   */
  noteStepCacheStats(
    usage: TokenUsage | undefined,
    window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
  ): void {
    const patch: Partial<AppState> = {};
    if (usage !== undefined) {
      const read = usage.inputCacheRead ?? 0;
      // Cache miss = tokens written into the cache (cache_creation). Plain
      // input (input_other) is not part of the cache system, so it must not
      // dilute the hit rate: read/(read+creation) is the exact hit rate.
      // OpenAI-compatible endpoints (Kimi/DeepSeek/OpenAI) report no cache
      // writes — their miss lands in input_other — so the gate also admits
      // plain input to keep the footer's fallback readout populated.
      const miss = usage.inputCacheCreation ?? 0;
      if (read > 0 || miss > 0 || (usage.inputOther ?? 0) > 0) {
        patch.cacheReadTokens = this.state.appState.cacheReadTokens + read;
        patch.cacheMissTokens = this.state.appState.cacheMissTokens + miss;
        // Keep plain input alongside so the footer can fall back to the
        // share of total input when the provider never reports cache writes
        // (otherwise read/(read+0) would always read 100%).
        patch.cacheOtherTokens = this.state.appState.cacheOtherTokens + (usage.inputOther ?? 0);
      }
    }
    const readout = this.tokenSpeed.addStep(
      window.llmFirstTokenOffsetMs,
      window.llmLastTokenOffsetMs,
      usage?.output ?? 0,
    );
    // Patched unconditionally so a step that could not be measured leaves both
    // figures where they were, rather than blanking one of them.
    patch.tokenSpeed = readout.step ?? 0;
    patch.tokenSpeedAverage = readout.average ?? 0;
    if (Object.keys(patch).length > 0) {
      this.setAppState(patch);
    }
  }

  /** The speed readout is session-scoped, like the stats beside it: a new
   *  session, a `/undo` context cut and a replay hydration all start it over
   *  rather than blending the new session's first step into the previous one. */
  resetTokenSpeed(): void {
    this.tokenSpeed.reset();
    this.setAppState({ tokenSpeed: 0, tokenSpeedAverage: 0 });
  }

  /** Session turn counter for the footer stats (user-facing turns only; the
   *  event handler skips plugin-internal turns before calling this). */
  noteSessionTurnStarted(): void {
    this.setAppState({
      sessionStats: bumpTurnCount(this.state.appState.sessionStats),
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
        this.state.appState.sessionStats,
        usage,
        llmStreamDurationMs,
        llmFirstTokenLatencyMs,
      ),
    });
  }

  /** Accumulate one tool-call wall time (started→result, measured in the
   *  event handler) into the footer session stats. */
  noteSessionToolCompleted(deltaMs: number): void {
    this.setAppState({
      sessionStats: accumulateToolDuration(this.state.appState.sessionStats, deltaMs),
    });
  }

  /** Compaction shrinks the cached prefix — reset the cache-break baseline. */
  noteCompactionFinished(): void {
    this.cacheHint.resetCacheBreakBaseline();
  }

  /** /undo cut the context — the next step's cache drop is expected, and the
   *  speed readout restarts rather than blending the pre-undo rate in. */
  noteContextCut(): void {
    this.cacheHint.resetCacheBreakBaseline();
    this.resetTokenSpeed();
  }

  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    const result = await new Promise<MigrationScreenResult>((resolve) => {
      const screen = new MigrationScreenComponent({
        plan,
        sourceHome: plan.sourceHome,
        targetHome: this.harness.homeDir,
        skipDecisionStep: this.migrateOnly,
        requestRender: () => {
          this.state.ui.requestRender();
        },
        onComplete: (r) => {
          resolve(r);
        },
      });
      this.mountEditorReplacement(screen);
    });
    this.restoreEditor();
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
   * trust this folder when the workspace is not trusted yet (project-level MCP
   * servers stay disabled while untrusted). A failed trust-info read is treated
   * as untrusted and still prompts. Choosing "don't trust" (or Esc) exits the
   * program before any session is created. A failed trust write still enters
   * the TUI for this process and re-asks on the next launch. Returns true when
   * the prompt started the event loop (the caller must not start it again).
   */
  /**
   * One-time MSYS2 install gate (Windows only). Skipping or a successful
   * install marks the prompt as shown so it never reappears; a failed install
   * leaves it unmarked so the next launch can retry. Returns true when the
   * prompt ran (the caller must not start the event loop again).
   */
  private async maybeRunMsys2Prompt(eventLoopStarted: boolean): Promise<boolean> {
    const deps = createMsys2PromptDeps();
    if (!(await shouldPromptMsys2(deps))) return false;
    if (!eventLoopStarted) this.startEventLoop();
    const choice = await new Promise<Msys2PromptChoice>((resolve) => {
      this.state.activeDialog = 'msys2-prompt';
      this.mountEditorReplacement(
        new Msys2PromptComponent({
          onSelect: (c) => {
            resolve(c);
          },
          onCancel: () => {
            resolve('skip');
          },
        }),
      );
    });
    this.state.activeDialog = null;
    if (choice === 'install') {
      const spinner = this.showProgressSpinner(t('tui.dialogs.msys2Prompt.installing'));
      const result = await installMsys2(deps);
      if (result.ok && result.bashPath !== undefined) {
        const switched = setUserShellPath(result.bashPath, deps);
        spinner.stop({ ok: true, label: t('tui.dialogs.msys2Prompt.installSuccess') });
        this.showStatus(
          switched
            ? t('tui.dialogs.msys2Prompt.restartHint')
            : t('tui.dialogs.msys2Prompt.installSuccessNoSwitch'),
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
    this.restoreEditor();
    return true;
  }

  private async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    const workDir = this.state.appState.workDir;
    let info: WorkspaceTrustInfo;
    try {
      info = await this.harness.getWorkspaceTrustInfo(workDir);
    } catch {
      info = {
        trusted: false,
        gatedMcpServers: [],
        gatedAdditionalDirs: [],
        additionalDirSources: [],
        warnings: [t('tui.messages.kimiTuiCouldNotInspectSettings')],
        instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
      };
    }
    if (info.trusted) {
      return false;
    }
    this.startEventLoop();
    const choice = await new Promise<TrustPromptChoice>((resolve) => {
      this.state.activeDialog = 'trust-prompt';
      this.mountEditorReplacement(
        new TrustPromptComponent({
          workDir,
          info,
          getAvailableRows: () =>
            this.state.terminal.rows - (this.state.ui instanceof TuiAltScreen ? 1 : 0),
          onSelect: (c) => {
            resolve(c);
          },
        }),
      );
    });
    this.state.activeDialog = null;
    if (choice !== 'trust') {
      // Declining trust exits the program (Claude Code's "No, exit" semantics):
      // stop() runs the standard shutdown path and ends in process.exit. The
      // editor is NOT restored first — its frame would linger as an orphaned
      // input box above the exit message; the prompt stays as the last frame.
      await this.stop();
      return true;
    }
    this.restoreEditor();
    try {
      await this.harness.trustWorkspace(workDir);
    } catch {}
    return true;
  }

  showHelpPanel(): void {
    this.dialogController.showHelpPanel();
  }

  showSessionPicker(): Promise<void> {
    return this.dialogController.showSessionPicker();
  }

  hideSessionPicker(): void {
    this.dialogController.hideSessionPicker();
  }

  async deleteSessionFromPicker(session: SessionRow): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would replace the picker
    // that is about to lock itself for the delete.
    this.dialogController.invalidateSessionPickerRequests();
    try {
      await this.waitForLazyCreation();
      if (session.id === this.state.appState.sessionId && this.session !== undefined) {
        await this.deleteCurrentSessionFromPicker(session);
        return;
      }
      await this.harness.deleteSession(session.id);
      // fetchSessions swallows refetch errors, so drop the row locally first —
      // a failed refetch must not resurrect it in the remounted list.
      this.state.sessions = this.state.sessions.filter((row) => row.id !== session.id);
      const requestToken = this.dialogController.sessionPickerRequestToken;
      await this.fetchSessions(this.state.sessionsScope);
      if (requestToken !== this.dialogController.sessionPickerRequestToken) return;
      if (this.state.activeDialog !== 'session-picker') return;
      this.dialogController.remountSessionPicker();
      this.showStatus(t('tui.messages.kimiTuiSessionDeleted'));
    } catch (error) {
      this.showError(
        t('tui.messages.kimiTuiDeleteSessionFailed', {
          sessionId: session.id,
          error: formatErrorMessage(error),
        }),
      );
    }
  }

  private async deleteCurrentSessionFromPicker(session: SessionRow): Promise<void> {
    // The picker stays mounted (locking input) until the replacement session
    // is ready — restoring the editor mid-flight would let a prompt race the swap.
    try {
      // Tear down before deleting so no events from the dying session reach the UI.
      await this.closeSession('deleting session');
      await this.harness.deleteSession(session.id);
    } catch (error) {
      // The engine aborts a failed delete and keeps the session: reattach,
      // falling back to a fresh session if it is gone. showError runs after
      // the switch because switchToSession clears the transcript.
      const message = t('tui.messages.kimiTuiDeleteSessionFailed', {
        sessionId: session.id,
        error: formatErrorMessage(error),
      });
      try {
        const resumed = await this.harness.resumeSession({
          id: session.id,
          replayTurnLimit: REPLAY_TURN_LIMIT,
        });
        await this.switchToSession(
          resumed,
          t('tui.statusMessages.resumedSession', { sessionId: resumed.id }),
        );
      } catch {
        // Reattach failed and the session is already unloaded: detach before
        // the fallback create so a failed create leaves no ghost UI behind.
        this.setAppState({ sessionId: '' });
        this.transcriptRenderer.clearTranscriptAndRedraw();
        await this.createNewSession();
      }
      this.showError(message);
      this.hideSessionPicker();
      return;
    }
    // The session is gone whether or not replacement creation succeeds: detach
    // first so a failed create leaves no ghost (stale id + transcript) behind.
    this.setAppState({ sessionId: '' });
    this.transcriptRenderer.clearTranscriptAndRedraw();
    await this.createNewSession();
    this.hideSessionPicker();
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, '');
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    this.state.activeDialog = 'session-picker';
    const picker = new SessionPickerComponent({
      sessions: this.state.sessions,
      loading: this.state.loadingSessions,
      currentSessionId: this.state.appState.sessionId,
      scope: this.state.sessionsScope,
      initialSelectedSessionId: options.initialSelectedSessionId,
      pageSize: SESSION_LIST_PAGE_SIZE,
      hasMore: this.state.sessionsNextCursor !== undefined,
      loadingMore: this.state.sessionsLoadingMore,
      onLoadMore: () => {
        void this.fetchMoreSessions();
      },
      onSearchDrain: () => {
        void this.drainSessionsForSearch();
      },
      onSelect: (session: SessionRow) =>
        this.handleSessionPickerSelect(session, options.applyStartupModes === true).catch(
          (error) => {
            this.showError(`Failed to apply startup flags: ${formatErrorMessage(error)}`);
          },
        ),
      onCancel: options.onCancel,
      onCtrlC: options.onCtrlC,
      onCtrlD: options.onCtrlD,
      onToggleScope: (selectedSessionId: string) => {
        void this.toggleSessionPickerScope(selectedSessionId);
      },
      onDeleteRequest: (session: SessionRow) => this.deleteSessionFromPicker(session),
    });
    this.sessionPickerComponent = picker;
    this.mountEditorReplacement(picker);
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would replace the picker
    // and drop the selection lock.
    this.sessionPickerScopeRequestToken += 1;
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
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

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Kimi Code approval required',
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: beginScreenTakeover swaps the viewer in (root
  // children in regular mode, layout root in fullscreen) and closing restores
  // it. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    const takeover = beginScreenTakeover(this.state.ui, viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, takeover, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    endScreenTakeover(this.state.ui, preview.takeover);
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Kimi Code needs your answer',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }
}

function isSteerableQueuedMessage(message: QueuedMessage): boolean {
  return (
    message.inlineSkillActivations === undefined &&
    message.mode !== 'bash'
  );
}

function toSteerInputItem(message: QueuedMessage): SteerInputItem {
  return {
    text: message.text,
    parts: message.parts,
    imageAttachmentIds: message.imageAttachmentIds,
    videoAttachmentIds: message.videoAttachmentIds,
    mediaSnapshots: message.mediaSnapshots,
    inlineSkillActivations: message.inlineSkillActivations,
  };
}
