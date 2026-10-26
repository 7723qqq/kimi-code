import { truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import { currentTheme } from '../../theme';

import type { MoonLoader } from './moon-loader';

export type PromptOptimizerPhase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool'; readonly toolName: string; readonly detail?: string }
  | { readonly kind: 'writing' };

function phaseText(phase: PromptOptimizerPhase): string {
  switch (phase.kind) {
    case 'starting':
      return t('tui.messages.promptOptimizePhases.starting');
    case 'thinking':
      return t('tui.messages.promptOptimizePhases.thinking');
    case 'writing':
      return t('tui.messages.promptOptimizePhases.writing');
    case 'tool': {
      const detail = phase.detail === undefined || phase.detail.length === 0 ? '' : ` ${phase.detail}`;
      return t('tui.messages.promptOptimizePhases.tool', { tool: `${phase.toolName}${detail}` });
    }
  }
}

/**
 * The one-row live status of an in-flight Ctrl+P rewrite.
 *
 * It owns its own spinner rather than borrowing the activity pane's: the pane's
 * spinner belongs to the main agent's live state (`streamingPhase`,
 * `livePane.mode`), and sharing it would make the rewrite's progress show up as
 * main-flow activity. This row therefore never touches those fields — it is
 * mounted as its own child of the docked activity container and disappears when
 * the rewrite ends.
 */
export class PromptOptimizerActivityLine implements Component {
  private readonly loader: MoonLoader;
  private phase: PromptOptimizerPhase = { kind: 'starting' };

  constructor(loader: MoonLoader) {
    this.loader = loader;
  }

  setPhase(phase: PromptOptimizerPhase): void {
    this.phase = phase;
  }

  render(width: number): string[] {
    // `renderInline()` carries the frame with no label and no tip, which is what
    // this row wants: the phase text below is the label, and letting the loader
    // own it too painted the sentence twice. No `setAvailableWidth` call either —
    // that only exists to fit a tip the loader would otherwise append.
    const row = `${this.loader.renderInline()} ${currentTheme.fg('textDim', phaseText(this.phase))}`;
    return [truncateToWidth(row, width)];
  }

  invalidate(): void {}
}
