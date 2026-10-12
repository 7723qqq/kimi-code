/**
 * ApprovalRegion — an inline approval prompt inside the status surface.
 *
 * Approvals used to replace the editor outright (`mountEditorReplacement`).
 * That made the one blocking interaction in the app the one thing the user
 * could not type around: the draft disappeared while the prompt was up, and
 * the panel could grow to any height it liked because nothing above it was
 * competing for rows. Here the prompt is a region like the others, so it takes
 * the rows the shared budget grants it and leaves the editor mounted.
 *
 * The region lives in the strip's left half — the right half is the updates
 * panel's permanent slot — so the folded summary wraps to whatever width that
 * half has instead of assuming a whole row.
 *
 * The two shapes exist because an approval can be enormous (a diff of a whole
 * file) or trivial (one line of shell):
 *
 * - **Folded** — the question and the numbered options, packed into as many
 *   rows as the width needs, so the keyboard answers (`1`/`2`/`3`) and `Enter`
 *   remain usable without ever expanding. An approval the user can see but not
 *   answer would be worse than no fold at all.
 * - **Expanded** — the panel's own body, clipped to the granted budget below
 *   the summary; the full-screen preview (`Ctrl+E`) stays the place for
 *   reading a long diff.
 *
 * The region is `autoFocus` and `blocking`: the keyboard belongs to it while
 * it is up, and the editor refuses submissions until it resolves.
 */

import type { TuiMouseEventResult } from '@moonshot-ai/pi-tui';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import type { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type { ApprovalPanelChoice, ApprovalPanelData } from '#/tui/reverse-rpc/types';
import type {
  RegionId,
  RegionKey,
  RegionMouseEvent,
  RegionPlacement,
  RegionRenderContext,
  StatusRegion,
} from '../region';

/** A clickable span of one printed option, on the summary row that shows it. */
interface ApprovalOptionRange {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  /** Index into `data.choices`. */
  readonly choice: number;
}

/**
 * Rows the folded summary costs at any width: the question, one row per option,
 * and the key hint.
 *
 * One option per row rather than packed into as few rows as the width allows.
 * Packing made the answer depend on the terminal width — a wide column showed
 * `1.Allow  2.Allow for session` on one line and the wrap moved options around
 * under the user — and it read as one run-on sentence instead of a list of
 * things to choose between. The budget in rows is the cost of that clarity, and
 * an approval is the one blocking prompt in the strip, so it is served first.
 */
function summaryRowCost(choiceCount: number): number {
  return 2 + choiceCount;
}

export class ApprovalRegion implements StatusRegion {
  readonly id: RegionId = 'approval';
  /** The keyboard belongs to a pending approval the moment it appears. */
  readonly autoFocus = true;

  /** Served before the informational regions, so it is never starved of rows. */
  readonly priority = 0;
  /** An approval is an unanswered question: the editor holds submissions. */
  readonly blocking = true;
  /**
   * While a request is pending the prompt takes over the todo list's slot: the
   * todo list is informational, the approval is the one thing waiting on the
   * user, and it must not queue behind (or share the strip with) a long list.
   * The list comes back untouched once the request resolves.
   */
  readonly suppresses: readonly RegionId[] = ['todo'];

  private payload: ApprovalPanelData | undefined;
  private panel: ApprovalPanelComponent | undefined;
  private expanded = false;
  private selectedIndex = 0;
  /** Installed by the surface when the region is registered. */
  onChange: (() => void) | undefined;

  /** Clickable spans of the last paint, per summary row. */
  private optionRanges: readonly ApprovalOptionRange[] = [];
  /** Summary rows the last paint drew; the body starts below them. */
  private summaryRowCount = 0;
  /** Body rows the panel drew versus the rows it was granted, for the predicate. */
  private bodyRowsRendered = 0;
  private bodyBudgetGranted = 0;

  /**
   * The strip's left half, with the other informational regions.
   *
   * The right half is the updates panel's permanent slot, so an approval takes
   * the left one like the todo list it replaces.
   */
  placement(): RegionPlacement {
    return 'left';
  }

  /** Show a new request, creating the panel that renders its body. */
  show(payload: ApprovalPanelData, panel: ApprovalPanelComponent): void {
    this.payload = payload;
    this.panel = panel;
    this.expanded = false;
    this.selectedIndex = 0;
    // One signal: the surface repaints and, because this region is
    // `autoFocus`, takes the keyboard — which is what makes the prompt
    // answerable the moment it appears.
    this.onChange?.();
  }

  clear(): void {
    this.payload = undefined;
    this.panel = undefined;
    this.expanded = false;
    this.selectedIndex = 0;
    this.optionRanges = [];
    this.summaryRowCount = 0;
    this.bodyRowsRendered = 0;
    this.bodyBudgetGranted = 0;
    this.onChange?.();
  }

  data(): ApprovalPanelData | undefined {
    return this.payload;
  }

  panelComponent(): ApprovalPanelComponent | undefined {
    return this.panel;
  }

  isEmpty(): boolean {
    return this.payload === undefined;
  }

  /**
   * Rows wanted: the folded summary, or the summary plus the panel's own body
   * when expanded. Measured rather than estimated — a diff's height is the
   * whole point of the expanded form, and the summary's own row count is the
   * wrap it would paint at this width.
   */
  measure(width: number): number {
    if (this.payload === undefined) return 0;
    const summaryRows = summaryRowCost(this.payload.choices.length);
    if (!this.expanded) return summaryRows;
    return summaryRows + (this.panel?.render(width).length ?? 0);
  }

  render(ctx: RegionRenderContext): string[] {
    const data = this.payload;
    if (data === undefined) {
      this.summaryRowCount = 0;
      this.bodyRowsRendered = 0;
      this.bodyBudgetGranted = 0;
      return [];
    }
    const summary = this.renderSummary(data, ctx);
    // What the summary costs the *click* map, not what it produced: under a
    // budget too small for the whole summary the surface clips the tail, and a
    // row that is not on screen must not answer a click.
    this.summaryRowCount = Math.min(summary.length, Math.max(0, ctx.budget));
    const bodyBudget = Math.max(0, ctx.budget - summary.length);
    const body = this.panel?.render(ctx.width) ?? [];
    this.bodyRowsRendered = body.length;
    this.bodyBudgetGranted = bodyBudget;
    if (!this.expanded) return summary;
    // The summary stays on screen while reading the body; the body then takes
    // whatever the budget has left.
    return [...summary, ...body.slice(0, bodyBudget)];
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  /**
   * Whether unfolding would reveal rows that are not on screen.
   *
   * Folded, that is always true — the body is entirely hidden. Expanded, it
   * stays true while the granted budget still clips the body, so an approval
   * opened into a short strip can be closed again. The old answer was
   * `!expanded`, which made every expanded approval unfoldable-in-reverse:
   * the summary could be opened but never folded back.
   */
  hasHiddenContent(): boolean {
    if (this.payload === undefined) return false;
    if (!this.expanded) return true;
    return this.bodyRowsRendered > this.bodyBudgetGranted;
  }

  handleKey(key: RegionKey): boolean {
    const data = this.payload;
    if (data === undefined) return false;
    switch (key) {
      case 'toggle':
        this.expanded = !this.expanded;
        return true;
      case 'up':
        this.selectedIndex = wrapIndex(this.selectedIndex - 1, data.choices.length);
        return true;
      case 'down':
        this.selectedIndex = wrapIndex(this.selectedIndex + 1, data.choices.length);
        return true;
      case 'enter':
      case 'pageDown': {
        const choice = data.choices[this.selectedIndex];
        if (choice === undefined) return false;
        this.respond(choice);
        return true;
      }
      case 'digit1':
      case 'digit2':
      case 'digit3':
      case 'digit4':
      case 'digit5':
      case 'digit6':
      case 'digit7':
      case 'digit8':
      case 'digit9':
        return this.handleNumber(Number(key.slice('digit'.length)));
      // ←/→ step through the options too: the region owns the left column and
      // these are its own horizontal vocabulary, so they mean "pick", not
      // "switch column" — that move is `Tab`, a strip-level gesture.
      case 'left':
        this.selectedIndex = wrapIndex(this.selectedIndex - 1, data.choices.length);
        return true;
      case 'right':
        this.selectedIndex = wrapIndex(this.selectedIndex + 1, data.choices.length);
        return true;
      case 'escape': {
        this.panel?.reject();
        return true;
      }
      case 'pageUp':
        this.selectedIndex = 0;
        return true;
      default:
        return false;
    }
  }

  /**
   * Raw keys the editor passed up, before the surface normalizes them.
   *
   * `handleKey` speaks `RegionKey`, which carries no printable text and no Ctrl
   * shortcuts: enough to answer an approval, not enough to type a rejection
   * reason or to open the full-screen preview. The panel decides what it wants
   * and a `false` sends the key back to the editor.
   */
  handleRawInput(data: string): boolean {
    return this.panel?.handleSurfaceInput(data) ?? false;
  }

  /**
   * Numeric quick-pick, keyed by the number **shown on screen** (1-based).
   *
   * The folded form shows the numbers, so they have to work without expanding —
   * this is the whole reason the fold is safe. Taking the printed digit rather
   * than an array index keeps the caller from having to remember which
   * convention applies at each call site.
   */
  handleNumber(digit: number): boolean {
    const data = this.payload;
    if (data === undefined) return false;
    if (!Number.isInteger(digit) || digit < 1) return false;
    const choice = data.choices[digit - 1];
    if (choice === undefined) return false;
    this.respond(choice);
    return true;
  }

  /**
   * Click handling: the summary rows are the control surface.
   *
   * Folded, the summary is the whole region, so it has to be answerable
   * without unfolding — a prompt the user can see but not answer is worse
   * than no fold at all. The option numbers are printed on those rows, so
   * clicking one answers with it; clicking anywhere else on them unfolds.
   *
   * Expanded, the region is the panel's body and the panel knows its own row
   * geometry, so the click is handed down with the summary rows' offset
   * removed.
   */
  handleMouse(event: RegionMouseEvent): TuiMouseEventResult | undefined {
    if (this.payload === undefined) return undefined;
    if (event.type !== 'click' || event.button !== 'left') return undefined;

    if (event.y < this.summaryRowCount) {
      const range = this.optionRanges.find(
        (entry) => entry.row === event.y && event.x >= entry.start && event.x < entry.end,
      );
      if (range !== undefined) {
        const choice = this.payload.choices[range.choice];
        if (choice === undefined) return undefined;
        this.respond(choice);
        return { handled: true, render: true };
      }
      this.expanded = !this.expanded;
      return { handled: true, render: true };
    }

    if (!this.expanded) return undefined;
    return this.panel?.handleMouse?.({ ...event.raw, y: event.y - this.summaryRowCount });
  }

  /** The approval owns the keyboard while it is up. */
  wantsFocus(): boolean {
    return true;
  }

  /**
   * Answer the request through the panel.
   *
   * The panel owns the response callback (the dialog host wires it to the
   * approval controller), so routing the surface's shortcuts through it keeps
   * one path for both the folded and expanded forms — including the
   * `requires_feedback` choices, which only the panel knows how to prompt for.
   */
  private respond(choice: ApprovalPanelChoice): void {
    this.panel?.selectChoice(choice);
  }

  /** The key hint for the current fold state. */
  private summaryHint(): string {
    return this.expanded
      ? t('tui.chrome.statusSurface.approval.collapseHint')
      : t('tui.chrome.statusSurface.approval.expandHint');
  }

  /**
   * The always-visible rows: what is being asked, then one row per numbered
   * option, then the key hint.
   *
   * One option per row, so the answer reads as a list and the numbers keep
   * their places no matter how wide the column is. The ranges are recorded
   * while the rows are built rather than recomputed by the click handler: two
   * copies of the layout arithmetic is exactly how a hit test drifts from what
   * the user can see.
   */
  private renderSummary(data: ApprovalPanelData, ctx: RegionRenderContext): string[] {
    const palette = ctx.palette;
    const marker = ctx.focused
      ? chalk.hex(palette.accent).bold('▶')
      : chalk.hex(palette.primary).bold('▶');
    // Prefer the panel's own tool-specific prompt: it is what the expanded
    // form shows, and a generic fallback here would be a second phrasing that
    // drifts from it (and drops the wording the tool provided).
    const label = this.panel?.headerText() ?? data.tool_name;
    const question = `${marker} ${chalk.hex(palette.primary).bold(label)}`;
    const hint = chalk.hex(palette.textDim)(`· ${this.summaryHint()}`);
    const ranges: ApprovalOptionRange[] = [];
    const lines: string[] = [question];
    for (const [index, choice] of data.choices.entries()) {
      const number = `${index + 1}`;
      const numberText = chalk.hex(palette.textDim)(`${number}. `);
      const text =
        index === this.selectedIndex
          ? chalk.hex(palette.accent).bold(choice.label)
          : chalk.hex(palette.textStrong)(choice.label);
      const start = visibleWidth(numberText);
      const end = start + visibleWidth(text);
      ranges.push({ row: index + 1, start, end, choice: index });
      lines.push(`${numberText}${text}`);
    }
    lines.push(hint);
    this.optionRanges = ranges;
    return lines;
  }
}

function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
