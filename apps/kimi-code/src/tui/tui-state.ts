import type { Container } from '@moonshot-ai/pi-tui';
import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type TUI,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { TranscriptView } from '#/tui/components/messages/transcript-view';
import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';

import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { NotifyPanelComponent } from './components/chrome/notify-panel';
import { STATUS_SURFACE_MAX_ROWS } from './components/chrome/status-surface/budget';
import { StatusSurfaceComponent } from './components/chrome/status-surface/index';
import { ApprovalRegion } from './components/chrome/status-surface/regions/approval-region';
import { TodoRegion } from './components/chrome/status-surface/regions/todo-region';
import { UpdatesRegion } from './components/chrome/status-surface/regions/updates-region';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_TUI_CONFIG } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import type { BackgroundTasksMiniState } from './controllers/background-tasks-mini';
import { currentTheme, type Theme } from './theme';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';
import {
  setMarkdownAltScreenActive,
  setMarkdownMermaidMode,
  setMarkdownRenderLatex,
  setMarkdownRenderRequester,
} from './utils/markdown-options';
import { SYSTEM_RENDER_CLOCK, type RenderClock } from './utils/render-clock';
import { createTerminalState, type TerminalState } from './utils/terminal-state';

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
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  todoRegion: TodoRegion;
  notifyPanelContainer: GutterContainer;
  notifyPanel: NotifyPanelComponent;
  updatesRegion: UpdatesRegion;
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

export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  setMarkdownRenderLatex(initialAppState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true);
  setMarkdownMermaidMode(initialAppState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid);
  const ui =
    initialAppState.tuiMode === 'fullscreen'
      ? new TuiAltScreen(terminal, undefined, undefined, {
          // Mouse capture takes over the terminal's native link activation, so
          // route OSC 8 clicks through our own opener.
          openUrl,
          // Likewise, on Windows the terminal's native right-click paste is
          // intercepted; feed the clipboard to the focused component as a
          // bracketed paste instead (renderer only calls this on win32).
          onRightClickPaste: () => {
            const target = ui.getFocusedComponent();
            if (!target?.handleInput || clipboard?.getText === undefined) return;
            void clipboard
              .getText()
              .then((text) => {
                if (!text || ui.getFocusedComponent() !== target) return;
                target.handleInput?.(`\u001B[200~${text}\u001B[201~`);
                ui.requestRender();
              })
              .catch(() => {});
          },
          // Clickable pill centered on the transcript's last row while it is
          // scrolled away from the end.
          scrollToEndIndicator: () => currentTheme.fg('primary', t('tui.labels.jumpToBottom')),
          // A bare OSC 52 write reports success even where the terminal drops
          // it, so route selection copies through the same verified path
          // /copy uses and only claim success for native delivery.
          copySelection: async (text) => {
            try {
              return (await copyTextToClipboard(text)) === 'native';
            } catch {
              return false;
            }
          },
        })
      : new TuiMainScreen(terminal);

  setMarkdownAltScreenActive(ui instanceof TuiAltScreen);
  setMarkdownRenderRequester(() => {
    ui.requestRender(true);
  });

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const backgroundTasksMiniContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent({ terminalRows: () => terminal.rows });
  const notifyPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const notifyPanel = new NotifyPanelComponent(
    () => terminal.rows,
    () => ui.requestRender(),
  );
  // One status strip above the editor, holding the todo list, the mid-turn
  // updates and (when it arrives) an approval. The three used to be separate
  // mounts with separate data paths and separate height rules; the surface
  // owns the budget, the focus and the mouse routing for all of them. Regions
  // stack instead of sharing a row because a blocking approval needs the full
  // width for its diff, and columns would force every neighbour to re-flow.
  const statusSurface = new StatusSurfaceComponent({
    terminalRows: () => terminal.rows,
    onRequestRender: () => ui.requestRender(),
  });
  const todoRegion = new TodoRegion(todoPanel);
  const updatesRegion = new UpdatesRegion(notifyPanel);
  // The approval region renders the panel the dialog host builds for each
  // request, so it holds no panel of its own until one arrives.
  const approvalRegion = new ApprovalRegion();
  statusSurface.setRegion(todoRegion);
  statusSurface.setRegion(updatesRegion);
  statusSurface.setRegion(approvalRegion);
  const statusSurfaceContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  statusSurfaceContainer.addChild(statusSurface);
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const surveyContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent({ ...initialAppState }, () => {
    ui.requestRender();
  });

  let dockContainer: VStack | undefined;
  if (ui instanceof TuiAltScreen) {
    // Fullscreen (alternate screen): the transcript scrolls inside the primary
    // ScrollView while the rest of the chrome stays docked at the bottom. The
    // footer joins the dock later via mountFooter().
    // Sizing contract (mirrors pi's interactive layout): the transcript starts
    // from basis 0 and grows; the dock keeps its intrinsic height, with the
    // editor never squeezed below its 3 rows (top border / input / bottom
    // border) and the footer below 1 — otherwise the box outline gets clipped.
    const transcriptView = new TranscriptView(transcriptContainer);
    dockContainer = new VStack();
    // Dock sizing contract, in two layers.
    //
    // Layer 1 (here): a static ceiling per row, so no single panel can grow
    // without bound. Panels cap themselves too (layer 2, because "half the
    // terminal" is not expressible as a constant), but declaring it here means a
    // panel that forgets its own guard still cannot take the screen.
    //
    // Layer 2: the status strip's own shared budget (`STATUS_SURFACE_MAX_ROWS`),
    // and `terminalRows()`-derived budgets for the panels outside it.
    //
    // The numbers are each panel's own ceiling plus the chrome the panel adds
    // (borders, padding, header). Keep them in step with the panel constants:
    // status surface `STATUS_SURFACE_MAX_ROWS`, queue `MAX_VISIBLE_ROWS`.
    dockContainer.addChild(activityContainer, { shrink: 1, minSize: 0, maxSize: 6 });
    dockContainer.addChild(statusSurfaceContainer, {
      shrink: 1,
      minSize: 0,
      maxSize: STATUS_SURFACE_MAX_ROWS,
    });
    dockContainer.addChild(queueContainer, { shrink: 1, minSize: 0, maxSize: 8 });
    dockContainer.addChild(btwPanelContainer, { shrink: 1, minSize: 0, maxSize: 18 });
    dockContainer.addChild(surveyContainer, { shrink: 1, minSize: 0, maxSize: 5 });
    dockContainer.addChild(backgroundTasksMiniContainer, {
      shrink: 1,
      minSize: 0,
      // Half the terminal, re-read on every layout pass: the ceiling has to
      // follow a resize, unlike the constant panel caps above.
      maxSize: () => Math.floor(terminal.rows * 0.5),
    });
    dockContainer.addChild(editorContainer, { shrink: 1, minSize: 3 });
    const root = new VStack();
    root.addChild(transcriptView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    root.addChild(dockContainer, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
    ui.setLayoutRoot(root);
    ui.addLayoutEffect(() => {
      if (ui.getLayoutRoot() === root && transcriptView.updateStickyMessage()) ui.requestRender();
    });
  }

  return {
    ui,
    terminal,
    transcriptContainer,
    activityContainer,
    backgroundTasksMiniContainer,
    statusSurface,
    statusSurfaceContainer,
    todoPanelContainer,
    todoPanel,
    todoRegion,
    notifyPanelContainer,
    notifyPanel,
    updatesRegion,
    approvalRegion,
    queueContainer,
    btwPanelContainer,
    surveyContainer,
    editorContainer,
    dockContainer,
    editor,
    footer,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    renderClock: SYSTEM_RENDER_CLOCK,
    activitySpinner: null,
    toolOutputExpanded: false,
    sessions: [],
    loadingSessions: false,
    sessionsNextCursor: undefined,
    sessionsLoadingMore: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    editorReplacementMounted: false,
    tasksBrowser: undefined,
    tasksBrowserMini: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
    helloWorldModeEntry: undefined,
  };
}
