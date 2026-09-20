import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import type { AutocompleteItem, Component, Focusable, SlashCommand } from '@moonshot-ai/pi-tui';

import type { ColorToken, ThemeName } from '#/tui/theme';

import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  InlineSkillActivation,
  LoginProgressSpinnerHandle,
  QueuedMessage,
  TranscriptEntry,
} from '../types';
import type { SkillListSession } from './skills';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface KimiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /** When set, the command is hidden from the palette and blocked unless this flag is enabled. */
  readonly experimentalFlag?: string;
  /**
   * Generic argument autocompletion. `argumentPrefix` is the text typed after
   * `/<command> `; return suggestions or `null`. Declared as a plain function
   * property (not a method) so passing it around is `this`-free. Adapted to
   * pi-tui's `getArgumentCompletions` in the autocomplete setup.
   */
  readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';

/**
 * The surface slash-command handlers act on. Declared here rather than in
 * `dispatch.ts` so command modules depend on the contract, not on the
 * dispatcher that implements it - every handler module previously imported
 * backwards from `dispatch.ts` just to name this type.
 */
export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;
  /**
   * Rebuild the plugin slash-command list. With no session (v2 session-less
   * startup) this reads the app-global plugin commands instead, so `/plugins`
   * mutations apply before the first session exists.
   */
  refreshPluginCommands(session?: Session): Promise<void>;
  /**
   * Rebuild the skill slash-command list. With no session (v2 session-less
   * startup) this reads the workspace skills instead.
   */
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  /**
   * Seed appState with the config defaults the v2 engine would apply at
   * createSession time (model, permission, plan mode, thinking effort,
   * context cap). No-op semantics on a live session path: only /reload calls
   * it while still session-less.
   */
  hydrateLazyConfigDefaults(): Promise<void>;

  // Session
  requireSession(): Session;
  /**
   * Lazy-create the session on first use (v2 engine). Returns the existing
   * session, or undefined (with the error already surfaced) when creation
   * fails.
   */
  ensureSession(): Promise<Session | undefined>;
  /** Await the in-flight lazy session creation, if any (v2); no-op otherwise. */
  waitForLazyCreation(): Promise<void>;
  switchToSession(session: Session, message: string): Promise<void>;
  reloadCurrentSessionView(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  requestQueuedGoalPromotion?(): void;
  /** Reset the client-side cache-break baseline after the context was cut
   *  (/undo): the next step's cache-read drop is expected, not a break. */
  noteContextCut?(): void;
  /**
   * Last measured step's full input size — what a model/effort switch would
   * reprocess against the provider prompt cache. Undefined when there is no
   * measurable baseline (fresh session, post-compaction, or missing usage).
   */
  estimateSwitchLossTokens?(): number | undefined;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(
    auth: Pick<DeviceAuthorization, 'verificationUriComplete'> & {
      userCode?: string;
      title?: string;
    },
  ): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  setExitOpenUrl(url: string): void;
  /**
   * Register a task that takes over the process after the TUI has shut down
   * (instead of exiting): the runner awaits it and only exits when it returns.
   * Used by `/web` to keep a freshly started server attached to this terminal
   * until Ctrl+C.
   */
  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
  ): Promise<void>;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly authFlow: AuthFlowController;
}
