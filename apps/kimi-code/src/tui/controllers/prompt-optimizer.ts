import type { Session } from '@moonshot-ai/kimi-code-sdk';
import { isKimiError } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  PromptOptimizePanelComponent,
  type PromptOptimizeChoice,
} from '../components/dialogs/prompt-optimize-panel';
import type { TUIState } from '../tui-state';
import { formatErrorMessage } from '../utils/event-payload';
import type { PromptOptimizerActivityController } from './prompt-optimizer-activity';

const MAX_RECENT_TURN_CHARS = 400;

const MAX_RECENT_TURNS = 6;

/**
 * Rows the panel's diff region may occupy.
 *
 * The panel is mounted in place of the editor rather than as a full-screen
 * overlay, so it gets no height of its own: the budget is what the terminal can
 * spare once the panel's own chrome is accounted for. `PANEL_CHROME_ROWS` is
 * the whole frame — top border, title, two hints, a blank, the scroll
 * indicator, the wrapped-rows notice, a blank, the two choices, a blank and
 * the bottom border — which is 12 rows at its widest, so a budget that only
 * charged for 9 let the panel overflow a short terminal and push the choices
 * off screen. The floor keeps a usable window on a very short terminal.
 */
function diffBudget(terminalRows: number | undefined): number {
  const PANEL_CHROME_ROWS = 12;
  if (terminalRows === undefined || !Number.isFinite(terminalRows)) return 20;
  return Math.max(5, Math.min(40, terminalRows - PANEL_CHROME_ROWS));
}

/**
 * Media placeholders the editor owns, e.g. `[image #1 (640×480)]`.
 *
 * They are resolved back into attachments at submit time by an id lookup, so a
 * rewrite that paraphrases or drops one silently detaches the file. Only ids the
 * store actually holds count — a literal the user typed stays ordinary text.
 */
const MEDIA_PLACEHOLDER_RE = /\[(image|video) #(\d+)\b[^\]]*\]/g;

export interface PromptOptimizerHost {
  state: TUIState;
  session: Session | undefined;
  ensureSession(): Promise<Session | undefined>;
  showError(msg: string): void;
  showInfo(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: PromptOptimizePanelComponent, onDisplaced?: () => void): void;
  restoreEditor(): void;
  /**
   * Show or clear the in-flight rewrite signal on the editor. The rewrite waits
   * on a full LLM round-trip, so without it the editor looks frozen for the
   * whole request.
   */
  setEditorOptimizing(optimizing: boolean): void;
  /** Known media ids, so a rewrite cannot silently drop an attachment. */
  mediaPlaceholderIds(): ReadonlySet<number>;
  /** The one-row live status above the input box, owned by the host host. */
  readonly promptOptimizerActivity: PromptOptimizerActivityController;
  /**
   * Whether the `prompt_optimizer` experimental flag is on.
   *
   * The engine refuses on its own, but the TUI has to know first: with the flag
   * off the shortcut should not be an error-generating no-op.
   */
  promptOptimizerEnabled(): boolean;
}

export class PromptOptimizerController {
  private inFlight = false;
  private cancel: (() => void) | undefined;

  constructor(private readonly host: PromptOptimizerHost) {}

  promptOptimizerEnabled(): boolean {
    return this.host.promptOptimizerEnabled();
  }

  /**
   * Give up on the outstanding rewrite and keep the draft.
   *
   * Ctrl+C reaches this before the editor's own clear-on-Ctrl+C path, so the
   * key that looks like a cancel cannot wipe the text the user was rewriting.
   */
  cancelInFlight(): boolean {
    if (this.cancel === undefined) return false;
    this.cancel();
    return true;
  }

  async optimize(): Promise<void> {
    const { host } = this;
    if (!host.promptOptimizerEnabled()) {
      host.track('prompt_optimize_disabled');
      host.showError(t('tui.dialogs.promptOptimize.disabled'));
      return;
    }
    if (this.inFlight) {
      host.track('prompt_optimize_busy');
      host.showError(t('tui.dialogs.promptOptimize.busy'));
      return;
    }
    const draft = host.state.editor.getText().trim();
    if (draft.length === 0) {
      host.track('prompt_optimize_empty_draft');
      host.showError(t('tui.dialogs.promptOptimize.emptyDraft'));
      return;
    }

    const session = host.session ?? (await host.ensureSession());
    if (session === undefined) {
      host.showError(t('tui.dialogs.promptOptimize.noSession'));
      return;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    // Mounted before the request leaves: the row has to exist on the first
    // frame after Ctrl+P, and the engine's first event can be far behind it.
    host.promptOptimizerActivity.begin();
    this.inFlight = true;
    this.cancel = () => {
      controller.abort();
    };
    host.setEditorOptimizing(true);
    try {
      const recentTurns = await this.recentTurns(session);
      const optimized = await session.optimizePrompt(draft, {
        recentTurns,
        signal: controller.signal,
      });
      host.setEditorOptimizing(false);
      // The wait the row describes is over the moment the model answers; the
      // review step that follows is the user's turn, not the rewriter's.
      host.promptOptimizerActivity.clear();
      if (optimized.trim().length === 0) {
        host.track('prompt_optimize_unchanged', { reason: 'empty' });
        return;
      }
      if (optimized.trim() === draft) {
        host.track('prompt_optimize_unchanged', { reason: 'identical' });
        host.showInfo(t('tui.dialogs.promptOptimize.unchanged'));
        return;
      }
      const dropped = droppedMediaPlaceholders(draft, optimized, host.mediaPlaceholderIds());
      if (dropped.length > 0) {
        host.track('prompt_optimize_attachment_dropped', { count: dropped.length });
        host.showError(t('tui.dialogs.promptOptimize.attachmentDropped'));
        return;
      }
      await this.confirm(draft, optimized, Date.now() - startedAt);
    } catch (error) {
      if (controller.signal.aborted) {
        host.track('prompt_optimize_cancelled');
        return;
      }
      host.track('prompt_optimize_failed', { code: errorCodeOf(error) });
      host.showError(t('tui.dialogs.promptOptimize.failed', { error: formatErrorMessage(error) }));
    } finally {
      this.cancel = undefined;
      host.promptOptimizerActivity.clear();
      host.setEditorOptimizing(false);
      this.inFlight = false;
    }
  }

  private confirm(original: string, optimized: string, durationMs: number): Promise<void> {
    const { host } = this;
    return new Promise((resolve) => {
      const finish = (
        choice: PromptOptimizeChoice,
        options?: { readonly restoreEditor?: boolean },
      ): void => {
        if (host.state.activeDialog === 'prompt-optimize') {
          host.state.activeDialog = null;
        }
        // A panel displaced by a newer one (AskUserQuestion, a picker, …) no
        // longer owns the editor slot: restoring it would clear that panel.
        if (options?.restoreEditor !== false) host.restoreEditor();
        if (choice === 'accept') {
          host.track('prompt_optimize_accepted', {
            draftChars: original.length,
            rewriteChars: optimized.length,
            durationMs,
          });
          host.state.editor.setText(optimized, { preservePasteRegistry: true });
        } else {
          host.track('prompt_optimize_discarded', { draftChars: original.length });
        }
        resolve();
      };
      host.state.activeDialog = 'prompt-optimize';
      host.mountEditorReplacement(
        new PromptOptimizePanelComponent({
          original,
          optimized,
          onSelect: finish,
          maxVisible: diffBudget(host.state.terminal.rows),
        }),
        // `clear()`ed panels get no dispose hook, so without this the await
        // below (and the `inFlight` flag covering it) would never settle.
        () => {
          host.track('prompt_optimize_displaced');
          host.showError(t('tui.dialogs.promptOptimize.displaced'));
          finish('discard', { restoreEditor: false });
        },
      );
    });
  }

  /**
   * The newest user turns, oldest first, for the engine to put in the prompt.
   *
   * Each turn is capped here rather than in the engine because this is the only
   * place that knows the text is going to be pasted verbatim into a prompt: the
   * engine re-caps at the same width, so the two agree by construction.
   */
  private async recentTurns(session: Session): Promise<readonly string[] | undefined> {
    try {
      const context = await session.getContext();
      const prompts: string[] = [];
      for (let i = context.history.length - 1; i >= 0; i--) {
        const message = context.history[i];
        if (message === undefined || message.role !== 'user') continue;
        if (message.origin?.kind !== 'user') continue;
        const text = messageText(message.content);
        if (text.trim().length === 0) continue;
        prompts.unshift(text.slice(0, MAX_RECENT_TURN_CHARS));
        if (prompts.length === MAX_RECENT_TURNS) break;
      }
      return prompts.length === 0 ? undefined : prompts;
    } catch (error) {
      this.host.track('prompt_optimize_context_failed', { code: errorCodeOf(error) });
      return undefined;
    }
  }
}

function errorCodeOf(error: unknown): string {
  if (isKimiError(error)) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Placeholder literals present in the draft and missing from the rewrite.
 *
 * Comparing the literals rather than the ids keeps a permutation of the same
 * attachments from reading as a drop, while a rewrite that renumbered one is
 * still caught — the id is what the submit-time lookup uses.
 */
export function droppedMediaPlaceholders(
  draft: string,
  rewrite: string,
  knownIds: ReadonlySet<number>,
): readonly string[] {
  const idsIn = (text: string): Set<number> => {
    const found = new Set<number>();
    for (const match of text.matchAll(MEDIA_PLACEHOLDER_RE)) {
      const id = Number.parseInt(match[2] ?? '', 10);
      if (Number.isNaN(id) || !knownIds.has(id)) continue;
      found.add(id);
    }
    return found;
  };
  const before = idsIn(draft);
  const after = idsIn(rewrite);
  const dropped: string[] = [];
  for (const id of before) {
    if (!after.has(id)) dropped.push(`#${String(id)}`);
  }
  return dropped;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => {
      return (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      );
    })
    .map((part) => part.text)
    .join('');
}
