import {
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import { currentTheme } from '../../theme';
import type { MoonLoader } from './moon-loader';

export type PromptOptimizerPhase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool'; readonly toolName: string; readonly detail?: string }
  | { readonly kind: 'writing' };

/** Rows of activity the expanded form keeps before dropping the oldest. */
const EXPANDED_DETAIL_ROWS = 3;

function phaseText(phase: PromptOptimizerPhase): string {
  switch (phase.kind) {
    case 'starting':
      return t('tui.messages.promptOptimizePhases.starting');
    case 'thinking':
      return t('tui.messages.promptOptimizePhases.thinking');
    case 'writing':
      return t('tui.messages.promptOptimizePhases.writing');
    case 'tool': {
      const detail =
        phase.detail === undefined || phase.detail.length === 0 ? '' : ` ${phase.detail}`;
      return t('tui.messages.promptOptimizePhases.tool', { tool: `${phase.toolName}${detail}` });
    }
  }
}

/**
 * The live status of an in-flight Ctrl+P rewrite.
 *
 * Collapsed (the default) it is one row: what the rewrite is doing right now.
 * Expanded it keeps the last few steps above that row, so a run that moves
 * between reading files and writing text can be followed instead of guessed at.
 *
 * It owns its own spinner rather than borrowing the activity pane's: the pane's
 * spinner belongs to the main agent's live state (`streamingPhase`,
 * `livePane.mode`), and sharing it would make the rewrite's progress show up as
 * main-flow activity.
 */
export class PromptOptimizerActivityLine implements Component {
  private readonly loader: MoonLoader;
  private readonly onToggle: () => void;
  private phase: PromptOptimizerPhase = { kind: 'starting' };
  private expanded = false;
  /** Newest last; only the tail is drawn when expanded. */
  private readonly recent: string[] = [];

  constructor(loader: MoonLoader, onToggle: () => void = () => {}) {
    this.loader = loader;
    this.onToggle = onToggle;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  setPhase(phase: PromptOptimizerPhase): void {
    this.phase = phase;
    const text = phaseText(phase);
    // Stream events report the same phase over and over: every assistant token
    // is a delta, and a step boundary plus the tool result either side of it
    // both read as "thinking". Recording each one verbatim turned the expanded
    // step list into the same sentence three times.
    if (this.recent.at(-1) === text) return;
    this.recent.push(text);
    if (this.recent.length > EXPANDED_DETAIL_ROWS + 1) this.recent.shift();
  }

  /** Fold or unfold the step list. Returns whether anything changed. */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    return true;
  }

  /**
   * A click on the row unfolds it, so the pointer has the same gesture as
   * Ctrl+O. Only `click` toggles: one physical click reaches the row twice —
   * `press` on the way down, then a synthesized `click` on release — so acting
   * on both flipped the row open and shut within the same gesture, which is
   * what made it look like a flicker instead of an expansion.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left' || event.type !== 'click') return undefined;
    // A second click in a rapid double click carries clickCount 2; toggling it
    // would unfold and fold the list within one gesture — the same flicker the
    // press/click double dispatch used to cause.
    if (event.clickCount !== undefined && event.clickCount > 1) return { handled: true };
    this.onToggle();
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    // `renderInline()` carries the frame with no label and no tip, which is what
    // this row wants: the phase text below is the label, and letting the loader
    // own it too painted the sentence twice. No `setAvailableWidth` call either —
    // that only exists to fit a tip the loader would otherwise append.
    const hint = t(
      this.expanded
        ? 'tui.messages.promptOptimizePhases.hintExpanded'
        : 'tui.messages.promptOptimizePhases.hintCollapsed',
    );
    const status = `${this.loader.renderInline()} ${currentTheme.fg('textDim', phaseText(this.phase))}${currentTheme.fg('textMuted', ` · ${hint}`)}`;
    if (!this.expanded) return [truncateToWidth(status, width)];

    const history = this.recent.slice(0, -1).slice(-EXPANDED_DETAIL_ROWS);
    const rows = history.map((text) =>
      truncateToWidth(currentTheme.fg('textMuted', `  ${text}`), width),
    );
    rows.push(truncateToWidth(status, width));
    return rows;
  }

  invalidate(): void {}
}
