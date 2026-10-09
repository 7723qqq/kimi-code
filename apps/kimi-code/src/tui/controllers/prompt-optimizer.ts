import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import {
  PromptOptimizePanelComponent,
  type PromptOptimizeChoice,
} from '../components/dialogs/prompt-optimize-panel';
import type { TUIState } from '../tui-state';
import { formatErrorMessage } from '../utils/event-payload';

const MAX_RECENT_TURN_CHARS = 400;

export interface PromptOptimizerHost {
  state: TUIState;
  session: Session | undefined;
  ensureSession(): Promise<Session | undefined>;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: PromptOptimizePanelComponent): void;
  restoreEditor(): void;
  /**
   * Show or clear the in-flight rewrite signal on the editor. The rewrite waits
   * on a full LLM round-trip, so without it the editor looks frozen for the
   * whole request.
   */
  setEditorOptimizing(optimizing: boolean): void;
}

export class PromptOptimizerController {
  private inFlight = false;

  constructor(private readonly host: PromptOptimizerHost) {}

  async optimize(): Promise<void> {
    const { host } = this;
    if (this.inFlight) return;
    const draft = host.state.editor.getText().trim();
    if (draft.length === 0) return;

    const session = host.session ?? (await host.ensureSession());
    if (session === undefined) {
      host.showError(t('tui.dialogs.promptOptimize.noSession'));
      return;
    }

    this.inFlight = true;
    host.setEditorOptimizing(true);
    try {
      const recentTurns = await this.recentTurns(session);
      const optimized = await session.optimizePrompt(draft, { recentTurns });
      // The wait is over here. Clear before anything else so the signal covers
      // exactly the model round-trip and not the review step that follows —
      // `confirm` awaits the user, and holding the busy state across it would
      // leave the editor marked busy long after the rewrite finished.
      host.setEditorOptimizing(false);
      if (optimized.trim().length === 0 || optimized.trim() === draft) {
        host.track('prompt_optimize_unchanged');
        return;
      }
      await this.confirm(draft, optimized);
    } catch (error) {
      host.track('prompt_optimize_failed');
      host.showError(t('tui.dialogs.promptOptimize.failed', { error: formatErrorMessage(error) }));
    } finally {
      // Safety net for the throwing and early-return paths; the host makes a
      // repeated toggle a no-op.
      host.setEditorOptimizing(false);
      this.inFlight = false;
    }
  }

  private confirm(original: string, optimized: string): Promise<void> {
    const { host } = this;
    return new Promise((resolve) => {
      const finish = (choice: PromptOptimizeChoice): void => {
        if (host.state.activeDialog === 'prompt-optimize') {
          host.state.activeDialog = null;
        }
        host.restoreEditor();
        if (choice === 'accept') {
          host.track('prompt_optimize_accepted');
          host.state.editor.setText(optimized, { preservePasteRegistry: true });
        } else {
          host.track('prompt_optimize_discarded');
        }
        resolve();
      };
      host.state.activeDialog = 'prompt-optimize';
      host.mountEditorReplacement(
        new PromptOptimizePanelComponent({
          original,
          optimized,
          onSelect: finish,
        }),
      );
    });
  }

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
      }
      return prompts.length === 0 ? undefined : prompts;
    } catch (error) {
      this.host.track('prompt_optimize_context_failed', { error: formatErrorMessage(error) });
      return undefined;
    }
  }
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
