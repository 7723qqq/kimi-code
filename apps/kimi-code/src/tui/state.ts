import type { Container, ProcessTerminal, TUI, VStack } from '@moonshot-ai/pi-tui';

import type { FooterComponent } from './components/chrome/footer';
import type { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import type { NotifyPanelComponent } from './components/chrome/notify-panel';
import type { StatusSurfaceComponent } from './components/chrome/status-surface/index';
import type { ApprovalRegion } from './components/chrome/status-surface/regions/approval-region';
import type { StatsRegion } from './components/chrome/status-surface/regions/stats-region';
import type { UpdatesRegion } from './components/chrome/status-surface/regions/updates-region';
import type { SessionRow } from './components/dialogs/session-picker';
import type { CustomEditor } from './components/editor/custom-editor';
import type { BackgroundTasksMiniState } from './controllers/background-tasks-mini';
import type { TasksBrowserState } from './controllers/tasks-browser';
import type { Theme } from './theme';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  TranscriptEntry,
  TUIStartupState,
} from './types';
import type { RenderClock } from '#/utils/render-clock';
import type { TerminalState } from './utils/terminal-state';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: GutterContainer;
  activityContainer: Container;
  /**
   * Docked host for the background-tasks mini panel (the bottom-half peek).
   * Empty when the mini panel is closed.
   */
  backgroundTasksMiniContainer: Container;
  /**
   * The single strip above the editor. It supersedes the old side-by-side
   * `panelsRow` plus the separate approval panel that used to replace the
   * editor: todo, updates and approval are regions of this one component, and
   * it owns the shared height budget, focus and mouse routing.
   */
  statusSurface: StatusSurfaceComponent;
  statusSurfaceContainer: GutterContainer;
  notifyPanelContainer: GutterContainer;
  notifyPanel: NotifyPanelComponent;
  updatesRegion: UpdatesRegion;
  statsRegion: StatsRegion;
  /** Inline approval prompt; empty except while a request is pending. */
  approvalRegion: ApprovalRegion;
  queueContainer: Container;
  btwPanelContainer: Container;
  surveyContainer: Container;
  editorContainer: Container;
  /**
   * Fullscreen mode only: the bottom dock (activity/todo/notify/queue/btw/editor +
   * footer) stacked under the transcript ScrollView. Undefined in regular
   * mode, where all chrome is a direct child of the root container.
   */
  dockContainer: VStack | undefined;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  /**
   * Timer source for every animated row this state owns. Hosts that need
   * deterministic frames (tests, embeds driving their own scheduler) replace it;
   * the default is the process clock.
   */
  renderClock: RenderClock;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  toolOutputExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  /** Keyset cursor for the next older page; `undefined` when the listing is exhausted. */
  sessionsNextCursor: string | undefined;
  /** A follow-up session page fetch is in flight. */
  sessionsLoadingMore: boolean;
  sessionsScope: 'cwd' | 'all';
  activeDialog:
    | 'session-picker'
    | 'help'
    | 'trust-prompt'
    | 'msys2-prompt'
    | 'cache-hint'
    | 'prompt-optimize'
    | 'model-switch-confirm'
    | null;
  /**
   * True while an editor-replacement panel (help, trust prompt, goal queue
   * manager, …) is mounted in place of the editor. Delayed input restores
   * must not run in that state — they would displace the newer panel.
   */
  editorReplacementMounted: boolean;
  tasksBrowser: TasksBrowserState | undefined;
  tasksBrowserMini: BackgroundTasksMiniState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  /**
   * True while a queued user message has been shifted out of
   * {@link queuedMessages} but its deferred send has not run yet. The queue
   * looks empty during this window, so queued-goal promotion must also check
   * this flag to avoid starting a goal ahead of the user's earlier message.
   */
  queuedMessageDispatchPending: boolean;
  swarmModeEntry: 'manual' | 'task' | undefined;
  helloWorldModeEntry: 'manual' | 'task' | undefined;
}
