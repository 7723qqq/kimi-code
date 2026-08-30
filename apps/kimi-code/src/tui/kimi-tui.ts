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
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import {
  type Component,
  type Focusable,
  Spacer,
  TuiAltScreen,
  TuiMainScreen,
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
import { quoteShellArg } from '#/utils/shell-quote';
import { startupTrace } from '#/utils/startup-trace';
import { restoreTerminalModes } from '#/utils/terminal-restore';

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
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  getLlmNotSetMessage,
  getNoActiveSessionMessage,
  PRODUCT_NAME,
  SESSION_LIST_PAGE_SIZE,
  getSessionlessStartupNotice,
} from './constant/kimi-tui';
import { CHROME_GUTTER } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { ActivityPaneController } from './controllers/activity-pane';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { CacheHintController } from './controllers/cache-hint-controller';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint';
import { DialogHostController } from './controllers/dialog-host';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { MessageDispatchController } from './controllers/message-dispatch';
import { SessionEventHandler } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StagingLeaseTracker } from './controllers/staging-leases';
import { StreamingUIController } from './controllers/streaming-ui';
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
  type AppState,
  type InlineSkillActivation,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type SteerInputItem,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import { isExpandable } from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { pickForegroundTasks } from './utils/foreground-task';
import { ImageAttachmentStore } from './utils/image-attachment-store';
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
import { computeSmoothedTokenSpeed, pickDecodeMs } from './utils/token-speed';
import { markTranscriptComponent } from './utils/transcript-component-metadata';
import { nextTranscriptId } from './utils/transcript-id';
import { TRANSCRIPT_EXPAND_TURNS } from './utils/transcript-window';

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
}

type TurnStartedEvent = Extract<Event, { type: 'turn.started' }>;
type TurnEndedEvent = Extract<Event, { type: 'turn.ended' }>;

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
    sessionStats: createEmptySessionStats(),
    outputTokens: 0,
    locale: getLocale(),
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    renderLatex: input.tuiConfig.renderLatex,
    cacheExpiryHint: input.tuiConfig.cacheExpiryHint,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

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
  private tokenSpeedEma: number | null = null;
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

  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void {
    this.harness.track(event, properties);
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
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
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
    this.btwPanelController = new BtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
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
    const banner = await provider.load({
      state: displayState,
      now,
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
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
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
      await this.setSession(session);
      try {
        await this.syncRuntimeState(session);
      } catch (error) {
        // A transient getStatus/getGoal failure must not abort startup —
        // lazyCreateSession tolerates the same calls the same way, and the
        // next runtime update repopulates the state.
        log.warn('failed to sync runtime state on startup', { error: String(error) });
      }
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
    this.state.footer.dispose();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
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
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
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
    main.addChild(this.state.todoPanelContainer);
    main.addChild(this.state.queueContainer);
    main.addChild(this.state.btwPanelContainer);
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

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
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
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
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
        this.showError(`Shell command failed: ${message}`);
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
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
  ): Promise<void> {
    return this.messageDispatch.sendInlineSkillUserInput(text, activations, preExtracted);
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
    imageSnapshots?: readonly unknown[];
  }): boolean {
    return this.messageDispatch.validateMediaCapabilities(extraction);
  }

  beginSessionRequest(): void {
    this.messageDispatch.beginSessionRequest();
  }

  failSessionRequest(message: string): void {
    this.messageDispatch.failSessionRequest(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.messageDispatch.sendQueuedMessage(session, item);
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    this.messageDispatch.sendSkillActivation(session, skillName, skillArgs);
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    this.messageDispatch.activatePluginCommand(session, pluginId, commandName, args);
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    this.messageDispatch.steerMessage(session, input);
  }

  handleTurnStarted(event: TurnStartedEvent): void {
    this.staging.handleTurnStarted(event);
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    this.staging.handleTurnEnded(event);
  }

  releaseStagingMedia(mediaAttachmentIds: readonly number[]): void {
    this.staging.releaseMedia(mediaAttachmentIds, []);
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
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
    this.staging.releaseQueued(queued);
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    return first;
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
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
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
    // creation / `/new` before the first session), pass only the explicit CLI
    // --plan intent — and only when the engine is not already applying
    // `defaultPlanMode` at create time (sessionLifecycleService), since
    // re-entering an active plan mode throws.
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
    if (this.state.appState.lazySessionThinking !== undefined) {
      this.setAppState({ lazySessionThinking: undefined });
    }
    return session;
  }

  async setSession(session: Session): Promise<void> {
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
      swarmMode: status.swarmMode ?? false,
      towerMode: status.towerMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
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
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
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
    this.transcriptRenderer.clearTranscriptAndRedraw();
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
    if (this.state.appState.isReplaying) {
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
    this.transcriptRenderer.clearTranscriptAndRedraw();
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
    this.transcriptRenderer.appendTranscriptEntry(entry);
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
    this.state.transcriptContainer.addChild(new StatusMessageComponent(message, color));
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(new NoticeMessageComponent(title, detail));
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: t('tui.chrome.deviceCodeBox.title'),
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: t('tui.chrome.deviceCodeBox.hint'),
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner(t('tui.statusMessages.waitingForAuthorization'));
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    this.activityPaneController.updateActivityPane();
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
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;

    // A component is expandable only if it sits at or after the start of the
    // (totalTurns - expandTurns)-th turn — i.e. it belongs to one of the most
    // recent `expandTurns` turns. Position-based so it also covers streaming
    // components that have no entry in the metadata map.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.transcriptRenderer.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    const expandCutoff =
      TRANSCRIPT_EXPAND_TURNS <= 0
        ? children.length
        : boundaries.length > TRANSCRIPT_EXPAND_TURNS
          ? boundaries[boundaries.length - TRANSCRIPT_EXPAND_TURNS]!
          : 0;

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

  toggleTodoPanelExpansion(): void {
    this.state.todoPanel.toggleExpanded();
    this.state.ui.requestRender();
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
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = t('tui.messages.shellRun.backgrounded');
    this.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by agent-core via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
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
    const highlighted = this.state.appState.planMode || isBash || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
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

  mountEditorReplacement(panel: Component & Focusable): void {
    this.dialogController.mountEditorReplacement(panel);
  }

  restoreEditor(): void {
    this.dialogController.restoreEditor();
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
   * Per-step cache-hit and output-speed accounting for the footer readout:
   * accumulate cache hit/miss input tokens for the live hit rate, and fold
   * the step's decode-window + output-token count into the EMA that backs
   * `appState.tokenSpeed`.
   */
  noteStepCacheStats(
    usage: TokenUsage | undefined,
    streamDurationMs: number | undefined,
    serverDecodeMs: number | undefined,
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
    // Prefer the provider-reported decode window over the wall-clock stream
    // duration: a batched SSE response (or prompt-cache hit) collapses the
    // wall-clock between first and last event to a few ms and would otherwise
    // surface thousands of tok/s. Fall back to the stream duration only when
    // the provider stream omitted the decode accounting split.
    const decodeMs = pickDecodeMs(serverDecodeMs, streamDurationMs);
    const next = computeSmoothedTokenSpeed(this.tokenSpeedEma, usage?.output ?? 0, decodeMs);
    if (next !== null) {
      this.tokenSpeedEma = next;
      patch.tokenSpeed = next;
    }
    if (Object.keys(patch).length > 0) {
      this.setAppState(patch);
    }
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

  /** /undo cut the context — the next step's cache drop is expected. */
  noteContextCut(): void {
    this.cacheHint.resetCacheBreakBaseline();
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
   * servers stay disabled while untrusted). Best-effort throughout — a failed
   * check or trust write never blocks startup. Choosing "don't trust" (or Esc)
   * exits the program before any session is created; the prompt reappears on
   * the next launch: the engine's untrusted state is indistinguishable from
   * never-trusted. Returns true when the prompt started the event loop (the
   * caller must not start it again).
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
      return false;
    }
    if (info.trusted) return false;
    this.startEventLoop();
    const choice = await new Promise<TrustPromptChoice>((resolve) => {
      this.state.activeDialog = 'trust-prompt';
      this.mountEditorReplacement(
        new TrustPromptComponent({
          workDir,
          gatedMcpServers: info.gatedMcpServers,
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
    } catch {
      // A failed write leaves the workspace untrusted (re-asked next launch).
    }
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

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, '');
  }
}
