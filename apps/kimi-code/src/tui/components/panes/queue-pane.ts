import { Container, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
  /** Terminal rows, so the pane can hold itself to a share of the screen. */
  readonly terminalRows?: () => number;
}

const ELLIPSIS = '…';
/**
 * Total rows this pane may occupy, separator and hint included. A queue can grow
 * without bound while the user keeps typing, so without a ceiling the pane would
 * push the editor off screen — the same failure the Updates panel had.
 */
const MAX_VISIBLE_ROWS = 8;
/**
 * Fixed rows the pane spends before any message: the top separator. The hint is
 * added on top of this through `hintRows` so a hint-less pane keeps the rows.
 */
const PANE_OVERHEAD_ROWS = 1;
/** Floor on the total, so a very short terminal still shows the hint. */
const MIN_TOTAL_ROWS = 2;

export class QueuePaneComponent extends Container {
  private readonly messages: readonly QueuedMessage[];
  private readonly hint: string | undefined;
  private readonly terminalRows: () => number;
  /** Which optional rows the current budget allows; set by `visibleMessages`. */
  private drawnHint = true;
  private drawnNotice = false;

  constructor(options: QueuePaneOptions) {
    super();
    this.messages = options.messages;
    this.terminalRows = options.terminalRows ?? (() => 0);

    if (options.messages.length > 0) {
      // Bash commands (`! …`) are not steerable, so only advertise Ctrl-S when
      // there is at least one plain-text item that steering would actually send.
      const hasSteerable = options.messages.some((m) => m.mode !== 'bash');
      const canSteer = options.canSteerImmediately && hasSteerable;
      this.hint =
        options.isCompacting && !options.isStreaming
          ? t('tui.dialogs.queuePane.hintCompacting')
          : canSteer
            ? t('tui.dialogs.queuePane.hintSteer')
            : t('tui.dialogs.queuePane.hintAfterTask');
    }
  }

  /**
   * Total lines this pane may draw, separator and hint included: the fixed
   * ceiling or half the terminal, whichever is smaller. Expressed in total rows
   * so the pane as a whole respects the budget rather than only its message list.
   */
  private totalBudget(): number {
    const rows = this.terminalRows();
    return !Number.isFinite(rows) || rows <= 0
      ? MAX_VISIBLE_ROWS
      : Math.max(MIN_TOTAL_ROWS, Math.min(MAX_VISIBLE_ROWS, Math.floor(rows / 2)));
  }

  /**
   * Messages to draw: the newest that fit, so the prompt about to be sent stays
   * visible.
   *
   * The separator and the hint are fixed chrome; the "N hidden" notice is not.
   * The notice is drawn only from rows the messages do not need, because on a
   * short terminal a visible queued prompt beats a count of the ones above it:
   * reserving a row for the notice would leave nothing to show.
   */
  private visibleMessages(): readonly QueuedMessage[] {
    if (this.messages.length === 0) return [];
    const budget = this.totalBudget();
    const separator = PANE_OVERHEAD_ROWS;
    const hint = this.hint === undefined ? 0 : 1;

    // Preference order when the budget is tight: newest message > hint > notice.
    // A queued prompt the user cannot see is the worst of the three outcomes —
    // it is about to be sent — so each lower priority gives up its row first.
    for (const notice of [1, 0]) {
      for (const withHint of [hint, 0]) {
        const room = budget - separator - withHint - notice;
        if (room >= 1) {
          this.drawnHint = withHint > 0;
          this.drawnNotice = notice > 0;
          const sliced = this.messages.slice(-room);
          this.drawnNotice = this.drawnNotice && sliced.length < this.messages.length;
          return sliced;
        }
      }
    }
    this.drawnHint = false;
    this.drawnNotice = false;
    // No room for a message at all; show one row so the pane is not blank.
    return this.messages.slice(-1);
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('accent', text);
    const shell = (text: string) => currentTheme.fg('shellMode', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const lines: string[] = [currentTheme.fg('border', '─'.repeat(width))];

    const visible = this.visibleMessages();
    const hidden = this.messages.length - visible.length;
    if (this.drawnNotice && hidden > 0) {
      lines.push(
        dim(
          truncateToWidth(
            t('tui.dialogs.queuePane.earlierHidden', { count: hidden }),
            width,
            ELLIPSIS,
          ),
        ),
      );
    }
    for (const item of visible) {
      const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
      const prefix = `  ${SELECT_POINTER} `;
      if (item.mode === 'bash') {
        // Shell commands get a `$ ` prompt and the shell-mode hue so they read
        // as commands, not as plain text that would be sent to the model.
        const prompt = '$ ';
        const availableWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(prompt));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix) + shell(prompt + truncated));
      } else {
        const availableWidth = Math.max(1, width - visibleWidth(prefix));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix + truncated));
      }
    }

    if (this.hint !== undefined && this.drawnHint) {
      lines.push(dim(truncateToWidth(this.hint, width, ELLIPSIS)));
    }

    return lines;
  }
}
