/**
 * TUI2 editor keyboard controller — editor input handling.
 *
 * Mirrors `tui/controllers/editor-keyboard.ts`. The v1 controller wired
 * callbacks onto a pi-tui `CustomEditor` instance; the tui2 version exposes
 * the same handlers as public methods that the tui2 editor component calls,
 * with editor state (draft text, input mode) living in the response store.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import {
  compressImageForModel,
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import type { WhichKeyAction } from '../components/dialogs/which-key';
import type { LeaderAction } from '../keybindings';
import { parseGoalCommand } from '../commands/goal';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from '../components/editor/file-mention-provider';
import { getEditorInput } from '../components/editor/editor-input-ref';
import { getPasteRegistry } from '../components/editor/paste-markers';
import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { loadInputHistory } from '#/utils/history/input-history';
import { parseImageMeta } from '#/utils/image/image-mime';
import { getInputHistoryFile } from '#/utils/paths';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
  getCtrlCHint,
  getCtrlDHint,
  getLlmNotSetMessage,
  getNoActiveSessionMessage,
} from '../constant/kimi-tui';
import type { Tui2Store } from '../state';
import type { PendingExit, QueuedMessage, SteerInputItem } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { ImageAttachmentStore } from '../utils/image-attachment-store';
import { extractMediaAttachments } from '../utils/image-placeholder';
import type { BtwPanelController } from './btw-panel';
import { createTranscriptNavController, type TranscriptNavController } from './transcript-navigation';

/** Todo panel overflow threshold (mirrors the v1 TodoPanelComponent). */
const MAX_VISIBLE_TODOS = 5;

/** Debounce window for live autocomplete requests while typing. */
const AUTOCOMPLETE_DEBOUNCE_MS = 120;

export interface EditorKeyboardHost {
  store: Tui2Store;
  session: Session | undefined;
  readonly engineV2: boolean;
  cancelInFlight: (() => void) | undefined;
  /**
   * The host's harness (KimiTUI always has one). Its `imageLimits` drives
   * paste-time image compression; hosts without one fall back to the
   * env/built-in default.
   */
  harness?: KimiHarness | undefined;

  handleUserInput(text: string): void;
  readonly btwPanelController: BtwPanelController;
  steerMessage(session: Session, input: readonly SteerInputItem[]): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean;
  recallLastQueued(): QueuedMessage | undefined;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  stop(exitCode?: number): Promise<void>;
  ensureSession(): Promise<Session | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  clearQueuedMessages(): void;
  setExternalEditorRunning(running: boolean): void;
  updateActivityPane(): void;
  /** Dispatch a slash command by name (e.g. `'model'`, `'sessions'`). */
  runSlashCommand(name: string, args?: string): void;
  /** Show the which-key modal (`ctrl+alt+k`). */
  showWhichKey(): void;
  /** Show the transient leader-chord overlay (non-focusable). */
  showLeaderOverlay(): void;
  /** Remove the transient leader-chord overlay. */
  hideLeaderOverlay(): void;
  /** Toggle the activity pane (leader+b). */
  toggleActivityPane(): void;
  /** Toggle the right-side agent status panel (leader+p). */
  toggleAgentPane(): void;
  /** Toggle the right-side diff review panel (leader+d). */
  toggleDiffReviewPane(): void;
  /** Release the terminal for the external editor. */
  stopForExternalEditor(): void;
  /** Restore the terminal after the external editor exits. */
  startAfterExternalEditor(): void;
  /**
   * Test seam: supply persisted input-history entries directly. When absent
   * the controller reads the shared JSONL history file for `workDir` — the
   * same channel the host's load/persist helpers use.
   */
  loadInputHistoryEntries?(): Promise<readonly string[]>;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly transcriptNav: TranscriptNavController;
  /** Persisted input-history entries (chronological); loaded lazily once. */
  private inputHistory: string[] | null = null;
  /** Active ↑/↓ browse session over persisted history; null when idle. */
  private historyBrowse: {
    index: number;
    savedDraft: string;
    mode: 'prompt' | 'bash';
  } | null = null;
  /** Draft text written by the most recent recall, so the echo of the
   *  programmatic write is not mistaken for a manual edit. */
  private lastRecalledText: string | undefined;
  private autocompleteProvider: FileMentionProvider | undefined;
  private autocompleteCommands: unknown;
  private autocompleteGeneration = 0;
  private autocompleteDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private autocompleteAbort: AbortController | undefined;
  private pasteImageInFlight = false;
  private lastGoalHint: string | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {
    this.transcriptNav = createTranscriptNavController(host.store);
    // Warm the history cache so the first ↑ press does not race the file read.
    void this.ensureInputHistory();
  }

  // ---------------------------------------------------------------------------
  // Editor callbacks (invoked by the tui2 editor component)
  // ---------------------------------------------------------------------------

  handleSubmit(text: string): void {
    this.handleNonEscapeInput();
    // Paste markers are expanded before dispatch so history, slash parsing
    // and the send path all see the real content (v1 submitted expanded text).
    const expanded = getPasteRegistry(this.host.store).expand(text);
    this.exitHistoryBrowse();
    this.closeAutocomplete();
    this.rememberSubmittedInput(expanded);
    this.host.handleUserInput(expanded);
  }

  handleChange(text: string): void {
    if (this.pendingExit) this.clearPendingExit();
    // Any non-Esc input breaks the double-Esc undo window (v1 onNonEscapeInput).
    this.clearPendingUndoEsc();
    const { store } = this.host;
    const mode = store.state.inputMode;
    // Enter bash mode by typing `!` at the start of an empty prompt; leave it
    // when the bash line is emptied again (backspace to zero) — mirrors the
    // v1 CustomEditor's !-mode toggle.
    if (mode === 'prompt' && text.startsWith('!')) {
      this.host.handleInputModeChange('bash');
    } else if (mode === 'bash' && text.length === 0) {
      this.host.handleInputModeChange('prompt');
    }
    // Manual edits end an active ↑/↓ history browse session. The echo of a
    // programmatic recall passes through here too; matching text keeps it.
    if (this.historyBrowse !== null && text !== this.lastRecalledText) {
      this.exitHistoryBrowse();
    }
    // Markers only live while the draft references them.
    if (!text.includes('[paste #')) getPasteRegistry(store).clear();
    this.updateAutocomplete(text);
    this.updateGoalLengthHint(text);
    this.host.updateEditorBorderHighlight(text);
  }

  handleCtrlC(): void {
    const { host } = this;
    this.handleNonEscapeInput();
    if (host.cancelInFlight !== undefined) {
      const cancel = host.cancelInFlight;
      host.cancelInFlight = undefined;
      this.clearPendingExit();
      cancel();
      return;
    }

    // The btw panel stacks above the transcript, so Ctrl+C cancels/closes it
    // before touching an in-flight compaction or stream.
    if (host.btwPanelController.cancelRunning()) {
      this.clearPendingExit();
      return;
    }
    if (host.btwPanelController.closeOrCancel()) {
      this.clearPendingExit();
      return;
    }

    if (host.store.state.isCompacting) {
      this.clearPendingExit();

      if (this.clearEditorTextIfPresent()) return;

      this.cancelCurrentCompaction();
      return;
    }

    if (host.store.state.streamingPhase !== 'idle') {
      this.clearPendingExit();

      if (this.clearEditorTextIfPresent()) return;

      this.cancelCurrentStream();
      return;
    }

    if (this.pendingExit?.kind === 'ctrl-c') {
      this.clearPendingExit();
      void host.stop();
      return;
    }

    if (host.store.state.editorDraft.length > 0) {
      host.store.setState('editorDraft', '');
    }
    this.armPendingExit('ctrl-c', getCtrlCHint());
  }

  handleCtrlD(): void {
    this.handleNonEscapeInput();
    if (this.pendingExit?.kind === 'ctrl-d') {
      this.clearPendingExit();
      void this.host.stop();
      return;
    }
    this.armPendingExit('ctrl-d', getCtrlDHint());
  }

  handleEscape(): void {
    const { host } = this;
    if (this.pendingExit) this.clearPendingExit();
    // An open autocomplete popup is the topmost layer: Esc closes it instead
    // of cascading into dialog dismissal / stream cancel / undo-esc arming.
    if (host.store.state.editorAutocomplete !== undefined) {
      this.closeAutocomplete();
      return;
    }
    if (host.store.state.activeDialog === 'session-picker') {
      host.hideSessionPicker();
      this.clearPendingUndoEsc();
      return;
    }
    // The btw panel stacks above the transcript, so Esc dismisses it before
    // touching an in-flight compaction or stream.
    if (host.btwPanelController.closeOrCancel()) {
      this.clearPendingUndoEsc();
      return;
    }
    if (host.store.state.isCompacting) {
      this.cancelCurrentCompaction();
      this.clearPendingUndoEsc();
      return;
    }
    if (host.store.state.streamingPhase !== 'idle') {
      this.cancelCurrentStream();
      this.clearPendingUndoEsc();
      return;
    }
    // Idle: a second Esc within the double-tap window opens the undo selector.
    if (this.pendingUndoEsc !== null) {
      this.clearPendingUndoEsc();
      host.openUndoSelector();
      return;
    }
    this.armPendingUndoEsc();
  }

  handleShiftTab(): void {
    const { host } = this;
    this.handleNonEscapeInput();
    const togglePlan = (): void => {
      const next = !host.store.state.planMode;
      host.track('shortcut_plan_toggle', { enabled: next });
      host.track('shortcut_mode_switch', { to_mode: next ? 'plan' : 'agent' });
      host.handlePlanToggle(next);
    };
    if (host.session === undefined) {
      if (!host.engineV2) {
        host.showError(getNoActiveSessionMessage());
        return;
      }
      // v2 session-less: lazy-create the session, then toggle — the same
      // path /plan takes.
      void host.ensureSession().then((session) => {
        if (session !== undefined) togglePlan();
      });
      return;
    }
    togglePlan();
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.host.handleInputModeChange(mode);
  }

  handleOpenExternalEditor(): void {
    this.handleNonEscapeInput();
    this.host.track('shortcut_editor');
    void this.openExternalEditor();
  }

  handleToggleToolExpand(): void {
    this.handleNonEscapeInput();
    this.host.track('shortcut_expand');
    this.host.toggleToolOutputExpansion();
  }

  handleToggleTodoExpand(): boolean {
    if (this.host.store.state.todoItems.length <= MAX_VISIBLE_TODOS) return false;
    // Disarm a pending double-press exit confirmation so expanding the
    // todo list in between two Ctrl-C presses does not accidentally exit.
    this.clearPendingExit();
    this.host.track('shortcut_todo_expand');
    this.host.toggleTodoPanelExpansion();
    return true;
  }

  handleCtrlS(): void {
    const { host } = this;
    this.handleNonEscapeInput();
    if (
      host.store.state.streamingPhase === 'idle' ||
      host.store.state.streamingPhase === 'shell' ||
      host.store.state.isCompacting
    ) {
      return;
    }
    // Paste markers in the draft expand before extraction, so a steered
    // image/video placeholder (or large paste) reaches the turn as content.
    const text = getPasteRegistry(host.store).expand(host.store.state.editorDraft).trim();
    const editorIsBash = host.store.state.inputMode === 'bash';

    // Bash commands (`! …`) are not steerable: keep them queued so they run
    // after the current task instead of being injected into the turn as text.
    const queued = host.store.state.queuedMessages;
    const steerable = queued.filter((m) => m.mode !== 'bash');

    const items: SteerInputItem[] = [];
    for (const m of steerable) {
      const trimmed = m.text.trim();
      if (trimmed.length > 0) {
        // Queued items carry the parts extracted when they were submitted
        // (and were already capability-validated then).
        items.push({ text: trimmed, parts: m.parts, imageAttachmentIds: m.imageAttachmentIds });
      }
    }
    let editorExtraction: ReturnType<typeof extractMediaAttachments> | undefined;
    if (!editorIsBash && text.length > 0) {
      try {
        editorExtraction = extractMediaAttachments(text, this.imageStore);
      } catch (error) {
        // Cache copy failed (e.g. the pasted video's source vanished) —
        // leave the queue and the editor draft untouched.
        host.showError(
          t('tui.statusMessages.failedToPrepareMediaAttachment', {
            error: formatErrorMessage(error),
          }),
        );
        return;
      }
      items.push({
        text,
        parts: editorExtraction.hasMedia ? editorExtraction.parts : undefined,
        imageAttachmentIds:
          editorExtraction.imageAttachmentIds.length > 0
            ? editorExtraction.imageAttachmentIds
            : undefined,
      });
    }

    if (items.length > 0) {
      // The editor draft is fresh input: gate it on the model's media
      // capabilities before splicing the queue, so a rejection leaves the
      // queue and the draft untouched.
      if (editorExtraction !== undefined && !host.validateMediaCapabilities(editorExtraction)) {
        return;
      }
      const session = host.session;
      if (host.store.state.model.trim().length === 0 || session === undefined) {
        host.showError(getLlmNotSetMessage());
      } else {
        // Mutate the queue/editor only after the guard passes, so an
        // early-return here never drops the user's queued non-bash items or
        // the draft text.
        host.store.setState('queuedMessages', queued.filter((m) => m.mode === 'bash'));
        if (!editorIsBash) host.store.setState('editorDraft', '');
        host.steerMessage(session, items);
      }
    }
    host.updateQueueDisplay();
  }

  handleCtrlB(): boolean {
    const { host } = this;
    this.handleNonEscapeInput();
    // Shell command execution is treated as a streaming phase ('shell'), so
    // this gate already covers it; only idle + not-compacting falls through.
    if (host.store.state.streamingPhase === 'idle' || host.store.state.isCompacting) {
      return false;
    }
    host.track('shortcut_background_task');
    host.detachCurrentForegroundTask();
    return true;
  }

  handleUndo(): void {
    this.host.track('undo');
  }

  handleTextPaste(): void {
    this.handleNonEscapeInput();
    this.host.track('shortcut_paste', { kind: 'text' });
  }

  handleUpArrowEmpty(): boolean {
    const { host } = this;
    this.handleNonEscapeInput();
    // While the autocomplete popup is open the arrows navigate its list.
    if (host.store.state.editorAutocomplete !== undefined) {
      this.moveAutocompleteSelection(-1);
      return true;
    }
    if (host.btwPanelController.scroll('up')) return true;
    if (host.store.state.streamingPhase === 'idle' && !host.store.state.isCompacting) {
      // Idle: ↑ recalls persisted input history (v1 editor history semantics)
      // — entering requires an empty draft; an active browse session keeps
      // stepping older entries even though the draft holds a recall.
      if (host.store.state.editorDraft.length > 0 && this.historyBrowse === null) return false;
      return this.recallHistory(-1);
    }
    const recalled = host.recallLastQueued();
    if (recalled !== undefined) {
      host.store.setState('editorDraft', recalled.text);
      // Restore the queued item's mode so a recalled `!` command runs as a
      // shell command again instead of being submitted as a normal prompt.
      const mode = recalled.mode ?? 'prompt';
      if (host.store.state.inputMode !== mode) {
        host.store.setState('inputMode', mode);
        host.handleInputModeChange(mode);
      }
      host.updateQueueDisplay();
      return true;
    }
    return false;
  }

  handleDownArrowEmpty(): boolean {
    const { host } = this;
    this.handleNonEscapeInput();
    if (host.store.state.editorAutocomplete !== undefined) {
      this.moveAutocompleteSelection(1);
      return true;
    }
    if (this.historyBrowse !== null) return this.recallHistory(1);
    return this.host.btwPanelController.scroll('down');
  }

  /**
   * Apply the highlighted autocomplete suggestion to the draft (Enter / Tab
   * while the popup is open). Returns false when no popup is open so the key
   * can fall through.
   */
  acceptAutocomplete(): boolean {
    const { host } = this;
    this.handleNonEscapeInput();
    const ac = host.store.state.editorAutocomplete;
    if (ac === undefined) return false;
    const item = ac.items[ac.selectedIndex];
    this.closeAutocomplete();
    if (item === undefined) return true;
    const draft = host.store.state.editorDraft;
    // Completion is driven from the trailing token of the single-line input;
    // when the prefix is not the draft tail the popup is simply dismissed.
    if (!draft.endsWith(ac.prefix)) return true;
    // Slash-command completions gain a trailing space (mirrors the combined
    // provider's command branch); file/mention values carry their own rules.
    const isSlashCommand = ac.prefix.startsWith('/') && !ac.prefix.includes(' ');
    let value = item.value;
    if (isSlashCommand && !value.startsWith('/')) {
      value = `/${value}`;
    }
    const replacement = value + (isSlashCommand ? ' ' : '');
    host.store.setState(
      'editorDraft',
      draft.slice(0, draft.length - ac.prefix.length) + replacement,
    );
    return true;
  }

  async handlePasteImage(): Promise<boolean> {
    this.handleNonEscapeInput();
    // Clipboard reads are slow; a second press while one is in flight would
    // insert the attachment twice (v1 queued keys behind pasteInFlight —
    // dropping the repeat is enough here since the first paste lands).
    if (this.pasteImageInFlight) return true;
    this.pasteImageInFlight = true;
    try {
      return await this.pasteClipboardMedia();
    } finally {
      this.pasteImageInFlight = false;
    }
  }

  private async pasteClipboardMedia(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      const attachment = this.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
      this.insertTextAtCursor(`${attachment.placeholder} `);
      this.host.track('shortcut_paste', { kind: 'video' });
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    // Compress at ingestion — a pure data step while building the attachment, so
    // the stored bytes, the inline thumbnail, the `[image #N (W×H)]` placeholder,
    // and the submitted image all agree, and the agent core only ever sees an
    // already-compressed image. Best effort: originals pass through on failure.
    // When compression changed the bytes, the original is persisted (into the
    // session's media-originals dir when known, else the temp-dir fallback)
    // and recorded on the attachment, so submit-time expansion can announce
    // the compression and point the model at the full-fidelity copy.
    // The edge cap comes from the host harness's [image] config (resolved per
    // paste so a config reload applies immediately); hosts without a harness
    // use the env/built-in default.
    const compressed = await compressImageForModel(media.bytes, meta.mime, {
      maxEdge: this.host.harness?.imageLimits?.maxEdgePx(),
      telemetry: {
        client: {
          track: (event: string, properties?: Readonly<Record<string, unknown>>) => {
            this.host.track(event, properties as Record<string, unknown> | undefined);
          },
        },
        source: 'tui_paste',
      },
    });
    const sessionDir = this.host.session?.summary?.sessionDir;
    // Dimensions come from the compression result, not parseImageMeta: the
    // compressor reports display space (EXIF orientation applied) — the space
    // the sent image, the caption, and ReadMediaFile region readback share —
    // while parseImageMeta reads the raw pre-rotation header.
    const attachment = compressed.changed
      ? this.imageStore.addImage(
          compressed.data,
          compressed.mimeType,
          compressed.width,
          compressed.height,
          {
            path: await persistOriginalImage(
              media.bytes,
              meta.mime,
              sessionDir === undefined ? {} : { dir: sessionMediaOriginalsDir(sessionDir) },
            ),
            width: compressed.originalWidth,
            height: compressed.originalHeight,
            byteLength: media.bytes.length,
            mime: meta.mime,
          },
        )
      : this.imageStore.addImage(
          media.bytes,
          meta.mime,
          compressed.width || meta.width,
          compressed.height || meta.height,
        );
    this.insertTextAtCursor(`${attachment.placeholder} `);
    this.host.track('shortcut_paste', { kind: 'image' });
    return true;
  }

  handleLeaderAction(action: LeaderAction): void {
    this.handleNonEscapeInput();
    this.dispatchLeaderAction(action);
  }

  handleLeaderModeChange(active: boolean): void {
    const { host } = this;
    if (active) {
      host.showLeaderOverlay();
    } else {
      host.hideLeaderOverlay();
    }
  }

  handleShowWhichKey(): void {
    this.handleNonEscapeInput();
    this.host.showWhichKey();
  }

  // Transcript navigation mode: while active, j/k/↑/↓/Enter/Esc are
  // consumed here instead of reaching the editor buffer.
  handleTranscriptNavKey(data: string): boolean {
    return this.transcriptNav.handleKey(data);
  }

  /** Execute a command picked from the which-key palette. */
  dispatchWhichKeyAction(action: WhichKeyAction): void {
    this.handleNonEscapeInput();
    if (isLeaderAction(action)) {
      this.dispatchLeaderAction(action);
      return;
    }
    const { host } = this;
    switch (action) {
      case 'exit':
        void host.stop(0);
        return;
      case 'interrupt':
        host.cancelRunningShellCommand();
        return;
      case 'toggle-tool-output':
        host.toggleToolOutputExpansion();
        return;
      case 'detach':
        host.detachCurrentForegroundTask();
        return;
      case 'toggle-todo':
        host.toggleTodoPanelExpansion();
        return;
      case 'plan-mode':
        host.handlePlanToggle(!host.store.state.planMode);
        return;
      case 'steer':
      case 'escape':
      case 'which-key':
      case 'newline':
        return; // informational only
    }
  }

  private dispatchLeaderAction(action: LeaderAction): void {
    const { host } = this;
    switch (action) {
      case 'external-editor':
        host.track('shortcut_editor');
        void this.openExternalEditor();
        return;
      case 'model':
        host.runSlashCommand('model');
        return;
      case 'sessions':
        host.runSlashCommand('sessions');
        return;
      case 'new-session':
        host.runSlashCommand('new');
        return;
      case 'compact':
        host.runSlashCommand('compact');
        return;
      case 'undo':
        host.openUndoSelector();
        return;
      case 'redo':
        host.showError(t('tui.statusMessages.redoNotAvailable'));
        return;
      case 'status':
        host.runSlashCommand('status');
        return;
      case 'sidebar':
        host.toggleActivityPane();
        return;
      case 'theme':
        host.runSlashCommand('theme');
        return;
      case 'agent':
        host.runSlashCommand('team');
        return;
      case 'help':
        host.runSlashCommand('help');
        return;
      case 'navigate':
        this.transcriptNav.toggle();
        return;
      case 'agent-pane':
        host.toggleAgentPane();
        return;
      case 'review':
        host.toggleDiffReviewPane();
        return;
    }
  }

  /**
   * Any non-Escape input that reaches the editor resets the double-Esc undo
   * window (v1 `onNonEscapeInput`): Esc → <other key> → Esc must not open
   * the undo selector. Every non-Esc editor entry point calls this first.
   */
  handleNonEscapeInput(): void {
    this.clearPendingUndoEsc();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.store.setState('footerTransientHint', null);
    this.pendingExit = null;
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
    this.closeAutocomplete();
    this.exitHistoryBrowse();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * ↑/↓ recall over the persisted input history (v1 editor history semantics):
   * bash mode only lands on `!` entries; the filter is locked to the mode
   * captured when browse started, so landing on a shell entry mid-browse does
   * not switch it. Recalling a `!` entry strips the marker and restores bash
   * mode; stepping past the newest entry restores the pre-browse draft.
   */
  private recallHistory(direction: -1 | 1): boolean {
    const { host } = this;
    const entries = this.inputHistory;
    if (entries === null || entries.length === 0) return false;
    const entering = this.historyBrowse === null;
    if (entering) {
      this.historyBrowse = {
        index: entries.length,
        savedDraft: host.store.state.editorDraft,
        mode: host.store.state.inputMode,
      };
    }
    const browse = this.historyBrowse;
    if (browse === null) return false;
    let index = browse.index;
    while (true) {
      index += direction;
      if (index >= entries.length) {
        // Stepped past the newest entry: leave browse and restore the draft.
        const savedDraft = browse.savedDraft;
        const savedMode = browse.mode;
        this.exitHistoryBrowse();
        if (host.store.state.editorDraft !== savedDraft) {
          host.store.setState('editorDraft', savedDraft);
        }
        if (host.store.state.inputMode !== savedMode) {
          host.store.setState('inputMode', savedMode);
          host.handleInputModeChange(savedMode);
        }
        return true;
      }
      if (index < 0) {
        // Stepped past the oldest entry — a no-op, like v1.
        if (entering) this.exitHistoryBrowse();
        return false;
      }
      const candidate = entries[index] ?? '';
      if (browse.mode === 'bash' && !candidate.startsWith('!')) continue;
      break;
    }
    browse.index = index;
    const entry = entries[index] ?? '';
    this.lastRecalledText = entry;
    const recalledMode = entry.startsWith('!') ? 'bash' : 'prompt';
    if (host.store.state.inputMode !== recalledMode) {
      host.store.setState('inputMode', recalledMode);
      host.handleInputModeChange(recalledMode);
    }
    host.store.setState('editorDraft', recalledMode === 'bash' ? entry.slice(1) : entry);
    this.closeAutocomplete();
    return true;
  }

  private exitHistoryBrowse(): void {
    this.historyBrowse = null;
    this.lastRecalledText = undefined;
  }

  private rememberSubmittedInput(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Same consecutive-dedup rule as the host's persist channel. Before the
    // cache has loaded there is nothing to append in memory; the entry is on
    // disk already via the host's persistInputHistory.
    if (this.inputHistory === null) return;
    if (this.inputHistory.at(-1) === trimmed) return;
    this.inputHistory.push(trimmed);
  }

  private async ensureInputHistory(): Promise<readonly string[]> {
    if (this.inputHistory !== null) return this.inputHistory;
    let contents: readonly string[];
    if (this.host.loadInputHistoryEntries !== undefined) {
      contents = await this.host.loadInputHistoryEntries();
    } else {
      try {
        const file = getInputHistoryFile(this.host.store.state.workDir);
        contents = (await loadInputHistory(file)).map((entry) => entry.content);
      } catch {
        contents = [];
      }
    }
    this.inputHistory = [...contents];
    return this.inputHistory;
  }

  private moveAutocompleteSelection(delta: number): void {
    const ac = this.host.store.state.editorAutocomplete;
    if (ac === undefined || ac.items.length === 0) return;
    const next = Math.min(ac.items.length - 1, Math.max(0, ac.selectedIndex + delta));
    this.host.store.setState('editorAutocomplete', { ...ac, selectedIndex: next });
  }

  private updateAutocomplete(text: string): void {
    if (text.trim().length === 0) {
      this.closeAutocomplete();
      return;
    }
    this.autocompleteGeneration += 1;
    const generation = this.autocompleteGeneration;
    if (this.autocompleteDebounceTimer !== undefined) clearTimeout(this.autocompleteDebounceTimer);
    this.autocompleteDebounceTimer = setTimeout(() => {
      this.autocompleteDebounceTimer = undefined;
      void this.requestAutocomplete(text, generation);
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  }

  private async requestAutocomplete(text: string, generation: number): Promise<void> {
    const provider = this.ensureAutocompleteProvider();
    if (provider === undefined) return;
    this.autocompleteAbort?.abort();
    const abort = new AbortController();
    this.autocompleteAbort = abort;
    let suggestions;
    try {
      suggestions = await provider.getSuggestions([text], 0, text.length, {
        signal: abort.signal,
        force: false,
      });
    } catch {
      return;
    }
    if (generation !== this.autocompleteGeneration || abort.signal.aborted) return;
    if (suggestions === null || suggestions.items.length === 0) {
      this.closeAutocomplete();
      return;
    }
    this.host.store.setState('editorAutocomplete', {
      items: suggestions.items,
      selectedIndex: 0,
      prefix: suggestions.prefix,
    });
  }

  private closeAutocomplete(): void {
    this.autocompleteGeneration += 1;
    if (this.autocompleteDebounceTimer !== undefined) {
      clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = undefined;
    }
    this.autocompleteAbort?.abort();
    this.autocompleteAbort = undefined;
    if (this.host.store.state.editorAutocomplete !== undefined) {
      this.host.store.setState('editorAutocomplete', undefined);
    }
  }

  private ensureAutocompleteProvider(): FileMentionProvider | undefined {
    const { store } = this.host;
    const commands = store.state.autocompleteProvider;
    // Rebuild when the command catalog slice changes (/reload, skill refresh).
    if (this.autocompleteProvider !== undefined && this.autocompleteCommands === commands) {
      return this.autocompleteProvider;
    }
    if (!Array.isArray(commands)) return undefined;
    this.autocompleteCommands = commands;
    this.autocompleteProvider = new FileMentionProvider(
      commands as SlashAutocompleteCommand[],
      store.state.workDir,
      null,
      store.state.additionalDirs,
      () => store.state.inputMode,
    );
    return this.autocompleteProvider;
  }

  /**
   * Live pre-send warning while the typed `/goal` objective exceeds the
   * length limit, surfaced through the footer's transient-hint slot (v1 kept
   * a dedicated footer slot; tui2 reuses `footerTransientHint`, so a
   * simultaneous exit-confirm / clipboard hint temporarily displaces it).
   */
  private updateGoalLengthHint(text: string): void {
    if (this.host.store.state.inputMode === 'bash') {
      this.setGoalLengthHint(null);
      return;
    }
    const expanded = getPasteRegistry(this.host.store).expand(text);
    this.setGoalLengthHint(goalLengthHintFor(expanded));
  }

  private setGoalLengthHint(hint: string | null): void {
    if (hint === this.lastGoalHint) return;
    this.lastGoalHint = hint;
    this.host.store.setState('footerTransientHint', hint);
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.store.setState('footerTransientHint', hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
  }

  private clearEditorTextIfPresent(): boolean {
    if (this.host.store.state.editorDraft.length === 0) return false;
    this.host.store.setState('editorDraft', '');
    getPasteRegistry(this.host.store).clear();
    return true;
  }

  private cancelCurrentStream(): void {
    // Cancel any running `!` shell command (treated as a streaming phase) in
    // addition to the agent turn, so Esc / Ctrl+C interrupts it too.
    this.host.cancelRunningShellCommand();
    const session = this.host.session;
    if (session === undefined) return;
    // Cancel is best-effort and user-initiated; a rejection here is not worth
    // surfacing, but it must not become an unhandled rejection.
    void session.cancel().catch(() => {});
  }

  private cancelCurrentCompaction(): void {
    const session = this.host.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.host.showError(t('tui.statusMessages.compactionCancelFailed', { message }));
    });
  }

  private insertTextAtCursor(text: string): void {
    const { host } = this;
    // True cursor-position insertion through opentui's edit buffer when the
    // input renderable is mounted — `insertText` splices at the live cursor
    // offset and leaves it just past the inserted text. The draft is synced
    // from the buffer (the store echo is a no-op, so the cursor stays put).
    // Without a mounted input (tests / unmounted editor), fall back to
    // appending at the tail.
    const input = getEditorInput(host.store);
    if (input !== undefined) {
      input.insertText(text);
      host.store.setState('editorDraft', input.value);
      return;
    }
    host.store.setState('editorDraft', host.store.state.editorDraft + text);
  }

  private async openExternalEditor(): Promise<void> {
    const { host } = this;
    if (host.store.state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(host.store.state.editorCommand);
    if (cmd === undefined) {
      host.showError(t('tui.statusMessages.noEditorConfigured'));
      return;
    }
    host.setExternalEditorRunning(true);
    const seed = host.store.state.editorDraft;
    host.stopForExternalEditor();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        host.store.setState('editorDraft', result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(t('tui.messages.editorExternalFailed', { msg }));
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      host.startAfterExternalEditor();
      // terminal.stop() cleared the OSC 9;4 progress indicator while the
      // app-side progressActive flag still reads true; resync so a turn that
      // was streaming while the editor was open gets its progress back.
      host.store.patch('terminalState', { progressActive: false });
      host.updateActivityPane();
      host.setExternalEditorRunning(false);
    }
  }
}

// Shortcut-only actions (not leader chords). Overlapping members
// (external-editor, undo, navigate, agent-pane, review) resolve to the
// leader dispatch, which performs the same action.
const SHORTCUT_ONLY_ACTIONS = new Set<WhichKeyAction>([
  'exit',
  'interrupt',
  'steer',
  'detach',
  'toggle-tool-output',
  'toggle-todo',
  'plan-mode',
  'escape',
  'which-key',
  'newline',
]);

function isLeaderAction(action: WhichKeyAction): action is LeaderAction {
  return !SHORTCUT_ONLY_ACTIONS.has(action);
}

/**
 * Live `/goal` objective length check (v1 `goalObjectiveLengthWarning`).
 * Reuses tui2's exported {@link parseGoalCommand} unchanged: an over-long
 * objective is the one non-hint `error` it reports, every other error kind is
 * a transient incomplete-input state that must not warn while typing.
 */
function goalLengthHintFor(text: string): string | null {
  const trimmed = text.trimStart();
  if (!(trimmed.startsWith('/goal') && (trimmed.length === 5 || trimmed.charAt(5) === ' '))) {
    return null;
  }
  const parsed = parseGoalCommand(trimmed.slice('/goal'.length));
  return parsed.kind === 'error' && parsed.severity === undefined ? parsed.message : null;
}
