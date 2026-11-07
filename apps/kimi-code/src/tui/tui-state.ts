import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { TranscriptView } from '#/tui/components/messages/transcript-view';
import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';
import { SYSTEM_RENDER_CLOCK } from '#/utils/render-clock';

import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import { NotifyPanelComponent } from './components/chrome/notify-panel';
import { STATUS_SURFACE_MAX_ROWS } from './components/chrome/status-surface/budget';
import { StatusSurfaceComponent } from './components/chrome/status-surface/index';
import { ApprovalRegion } from './components/chrome/status-surface/regions/approval-region';
import { StatsRegion } from './components/chrome/status-surface/regions/stats-region';
import { UpdatesRegion } from './components/chrome/status-surface/regions/updates-region';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_TUI_CONFIG } from './config';
import { CHROME_GUTTER } from './constant/rendering';
import { CLICK_GUARD_MS } from './constant/terminal';
import type { TUIState } from './state';
import { currentTheme } from './theme';
import { INITIAL_LIVE_PANE, type KimiTUIOptions } from './types';
import {
  setMarkdownAltScreenActive,
  setMarkdownMermaidMode,
  setMarkdownRenderLatex,
  setMarkdownRenderRequester,
} from './utils/markdown-options';
import { createTerminalState } from './utils/terminal-state';

export type { TUIState } from './state';

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
          refocusMouseGuardMs: CLICK_GUARD_MS,
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
  const notifyPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const notifyPanel = new NotifyPanelComponent(
    () => terminal.rows,
    () => ui.requestRender(),
  );
  // One status strip above the editor, holding the mid-turn updates and (when
  // it arrives) an approval. The surface owns the budget, the focus and the
  // mouse routing for both. Folded, the approval takes the left column and the
  // updates box the right; unfolding claims the full band because the body is
  // the diff.
  const statusSurface = new StatusSurfaceComponent({
    terminalRows: () => terminal.rows,
    onRequestRender: () => ui.requestRender(),
  });
  const updatesRegion = new UpdatesRegion(notifyPanel);
  // The stats column is the only renderer of the session totals; it is built
  // by the same segment builder the footer used before its second line stopped
  // carrying them.
  const statsRegion = new StatsRegion();
  // The approval region renders the panel the dialog host builds for each
  // request, so it holds no panel of its own until one arrives.
  const approvalRegion = new ApprovalRegion();
  // The stats readout and a pending approval both declare the left column, so
  // they stack in one band when there is no updates box, and the surface
  // widens that column to the whole band because there is no right half to
  // split against. The updates box takes the right column whenever the left
  // one has anything in it.
  const approvalPresent = (): boolean => !approvalRegion.isEmpty();
  updatesRegion.setSiblingProbe(() => !statsRegion.isEmpty() || approvalPresent());
  statusSurface.setRegion(statsRegion);
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
  // The strip owns the session readout as soon as it has numbers; the footer
  // keeps its context readout only for the window before that, so the same
  // figure is never on screen twice.
  footer.setStatsShownProbe(() => !statsRegion.isEmpty());

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
    notifyPanelContainer,
    notifyPanel,
    updatesRegion,
    statsRegion,
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
