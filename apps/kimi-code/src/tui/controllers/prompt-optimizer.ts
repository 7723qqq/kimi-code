import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { PromptOptimizePanelComponent, type PromptOptimizeChoice } from '../components/dialogs/prompt-optimize-panel';
import { formatErrorMessage } from '../utils/event-payload';
import type { TUIState } from '../tui-state';

const MAX_RECENT_TURNS = 6;
const MAX_RECENT_TURN_CHARS = 400;

export interface PromptOptimizerHost {
  state: TUIState;
  session: Session | undefined;
  ensureSession(): Promise<Session | undefined>;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: PromptOptimizePanelComponent): void;
  restoreEditor(): void;
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
    try {
      const recentTurns = await this.recentTurns(session);
      const optimized = await session.optimizePrompt(draft, { recentTurns });
      if (optimized.trim().length === 0 || optimized.trim() === draft) {
        host.track('prompt_optimize_unchanged');
        return;
      }
      await this.confirm(draft, optimized);
    } catch (error) {
      host.track('prompt_optimize_failed');
      host.showError(t('tui.dialogs.promptOptimize.failed', { error: formatErrorMessage(error) }));
    } finally {
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

  private async recentTurns(session: Session): Promise<string | undefined> {
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
        if (prompts.length >= MAX_RECENT_TURNS) break;
      }
      return prompts.length === 0 ? undefined : prompts.join('\n');
    } catch {
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
