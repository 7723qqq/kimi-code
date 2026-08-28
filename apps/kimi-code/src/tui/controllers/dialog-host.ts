import type { Session } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { resolve } from 'pathe';

import { t } from '#/i18n';

import type { KimiSlashCommand } from '../commands';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from '../components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from '../components/dialogs/approval-preview';
import { HelpPanelComponent } from '../components/dialogs/help-panel';
import { QuestionDialogComponent } from '../components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from '../components/dialogs/session-picker';
import { SESSION_LIST_PAGE_SIZE } from '../constant/kimi-tui';
import { adaptPanelResponse } from '../reverse-rpc/approval/adapter';
import type { ApprovalController } from '../reverse-rpc/approval/controller';
import type { QuestionController } from '../reverse-rpc/question/controller';
import type { ApprovalPanelData, QuestionPanelData } from '../reverse-rpc/types';
import type { TUIState } from '../tui-state';
import type { LivePaneState } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import {
  beginScreenTakeover,
  endScreenTakeover,
  type ScreenTakeover,
} from '../utils/screen-takeover';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import type { EditorKeyboardController } from './editor-keyboard';

/**
 * Everything the dialog host needs from the `KimiTUI` coordinator: shared UI
 * state plus the session-runtime and presentation operations the dialogs
 * trigger. The reverse-rpc responders are injected directly.
 */
export interface DialogHost {
  readonly state: TUIState;
  readonly editorKeyboard: EditorKeyboardController;
  getSlashCommands(): readonly KimiSlashCommand[];
  fetchSessions(scope?: 'cwd' | 'all'): Promise<void>;
  fetchMoreSessions(waitForInFlight?: boolean): Promise<boolean>;
  drainSessionsForSearch(): Promise<void>;
  resumeSession(targetSessionId: string): Promise<boolean>;
  requireSession(): Session;
  stop(exitCode?: number): Promise<void>;
  applyStartupModesToResumedSession(session: Session): Promise<void>;
  applyStartupPermissionAndPlanToAppState(): void;
  showResumeOtherWorkDirHint(session: SessionRow): Promise<void>;
  showError(message: string): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  toggleToolOutputExpansion(): void;
  updateEditorBorderHighlight(text: string): void;
}

/**
 * Owns the editor-replacement lifecycle: the mount/restore primitives and the
 * full-screen dialogs that temporarily take over the input area (help panel,
 * session picker, approval panel + full-screen preview, question dialog).
 */
export class DialogHostController {
  private readonly host: DialogHost;
  private readonly approvalController: ApprovalController;
  private readonly questionController: QuestionController;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the previous screen is
  // stashed in `takeover` (root children in regular mode, the layout root in
  // fullscreen); closing restores it.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        takeover: ScreenTakeover;
        panel: ApprovalPanelComponent;
      }
    | undefined;

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
  private sessionPickerComponent: SessionPickerComponent | undefined;

  constructor(
    host: DialogHost,
    approvalController: ApprovalController,
    questionController: QuestionController,
  ) {
    this.host = host;
    this.approvalController = approvalController;
    this.questionController = questionController;
  }

  mountEditorReplacement(panel: Component & Focusable): void {
    this.host.state.editorReplacementMounted = true;
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(panel);
    this.host.state.ui.setFocus(panel);
    this.host.state.ui.requestRender();
  }

  restoreEditor(): void {
    this.host.state.editorReplacementMounted = false;
    this.host.state.editorContainer.clear();
    this.host.state.editorContainer.addChild(this.host.state.editor);
    this.host.state.ui.setFocus(this.host.state.editor);
    // Differential render only: closing a tall panel leaves the editor a few
    // rows above the bottom (blank tail) until the next append, but avoids a
    // destructive full redraw on every dialog close.
    this.host.state.ui.requestRender();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.host.state.editor.setText(text);
    this.host.updateEditorBorderHighlight(text);
    this.host.state.ui.requestRender();
  }

  showHelpPanel(): void {
    this.host.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.host.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.host.state.activeDialog = null;
    this.restoreEditor();
  }

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  async bootstrapFromPicker(): Promise<void> {
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
    await this.host.fetchSessions('cwd');
    this.mountSessionPicker({
      applyStartupModes: options.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (options.closeOnCancel) void this.host.stop();
      },
      onCtrlC: options.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: options.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  private async toggleSessionPickerScope(selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.host.state.sessionsScope === 'cwd' ? 'all' : 'cwd';
    await this.host.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.host.state.activeDialog !== 'session-picker') return;
    this.mountSessionPicker({
      initialSelectedSessionId: selectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.host.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.host.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.sessionPickerComponent = undefined;
    this.host.editorKeyboard.clearPendingExit();
    this.host.state.activeDialog = null;
    this.restoreEditor();
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
    this.host.state.activeDialog = 'session-picker';
    const picker = new SessionPickerComponent({
      sessions: this.host.state.sessions,
      loading: this.host.state.loadingSessions,
      currentSessionId: this.host.state.appState.sessionId,
      scope: this.host.state.sessionsScope,
      initialSelectedSessionId: options.initialSelectedSessionId,
      pageSize: SESSION_LIST_PAGE_SIZE,
      hasMore: this.host.state.sessionsNextCursor !== undefined,
      loadingMore: this.host.state.sessionsLoadingMore,
      onLoadMore: () => {
        void this.host.fetchMoreSessions();
      },
      onSearchDrain: () => {
        void this.host.drainSessionsForSearch();
      },
      onSelect: (session: SessionRow) => {
        void this.handleSessionPickerSelect(session, options.applyStartupModes === true).catch(
          (error) => {
            this.host.showError(`Failed to apply startup flags: ${formatErrorMessage(error)}`);
          },
        );
      },
      onCancel: options.onCancel,
      onCtrlC: options.onCtrlC,
      onCtrlD: options.onCtrlD,
      onToggleScope: (selectedSessionId: string) => {
        void this.toggleSessionPickerScope(selectedSessionId);
      },
    });
    this.sessionPickerComponent = picker;
    this.mountEditorReplacement(picker);
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.host.state.appState.workDir)) {
      await this.host.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.host.stop(0);
      return;
    }

    const switched = await this.host.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.host.applyStartupModesToResumedSession(this.host.requireSession());
      this.host.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  showApprovalPanel(payload: ApprovalPanelData): void {
    this.host.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.host.state, `approval:${payload.id}`, {
      title: t('tui.messages.kimiTuiApprovalRequired'),
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.host.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.host.patchLivePane({ pendingApproval: null });
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
      this.host.state.terminal,
    );
    const takeover = beginScreenTakeover(this.host.state.ui, viewer);
    this.host.state.ui.setFocus(viewer);
    this.host.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, takeover, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    endScreenTakeover(this.host.state.ui, preview.takeover);
    this.host.state.ui.setFocus(preview.panel);
    this.host.state.ui.requestRender(true);
  }

  showQuestionDialog(payload: QuestionPanelData): void {
    this.host.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.host.state, `question:${payload.id}`, {
      title: t('tui.messages.kimiTuiNeedsAnswer'),
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.host.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  hideQuestionDialog(): void {
    this.host.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

  /**
   * Monotonic token bumped on picker close/scope switch; in-flight page
   * fetches (fetchMoreSessions on the host) compare against it to discard
   * superseded results.
   */
  get sessionPickerRequestToken(): number {
    return this.sessionPickerScopeRequestToken;
  }

  setSessionPickerPaging(hasMore: boolean, loadingMore: boolean): void {
    this.sessionPickerComponent?.setPaging(hasMore, loadingMore);
  }

  appendSessionPickerRows(rows: SessionRow[]): void {
    this.sessionPickerComponent?.appendSessions(rows);
  }
}
