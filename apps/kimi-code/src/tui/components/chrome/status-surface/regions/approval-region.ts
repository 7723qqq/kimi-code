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
 * The two shapes exist because an approval can be enormous (a diff of a whole
 * file) or trivial (one line of shell):
 *
 * - **Folded** — one summary row that always carries the option numbers, so
 *   the keyboard answers (`1`/`2`/`3`) and `Enter` remain usable without ever
 *   expanding. An approval the user can see but not answer would be worse than
 *   no fold at all.
 * - **Expanded** — the panel's own body, clipped to the granted budget; the
 *   full-screen preview (`Ctrl+E`) stays the place for reading a long diff.
 *
 * The region is `autoFocus` and `blocking`: the keyboard belongs to it while
 * it is up, and the editor refuses submissions until it resolves.
 */

import type { TuiMouseEventResult } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { t } from '#/i18n';
import type { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type { ApprovalPanelChoice, ApprovalPanelData } from '#/tui/reverse-rpc/types';
import type {
  RegionId,
  RegionKey,
  RegionMouseEvent,
  RegionRenderContext,
  StatusRegion,
} from '../region';

/** Rows the folded form takes: the summary line only. */
export const APPROVAL_FOLDED_ROWS = 1;

export class ApprovalRegion implements StatusRegion {
  readonly id: RegionId = 'approval';
  /** The keyboard belongs to a pending approval the moment it appears. */
  readonly autoFocus = true;

  private payload: ApprovalPanelData | undefined;
  private panel: ApprovalPanelComponent | undefined;
  private expanded = false;
  private selectedIndex = 0;
  /** Installed by the surface when the region is registered. */
  onChange: (() => void) | undefined;

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
   * Rows wanted: the folded summary, or the panel's own body when expanded.
   * Measured from the panel rather than estimated — a diff's height is the
   * whole point of the expanded form.
   */
  measure(width: number): number {
    if (this.payload === undefined) return 0;
    if (!this.expanded) return APPROVAL_FOLDED_ROWS;
    return this.panel?.render(width).length ?? APPROVAL_FOLDED_ROWS;
  }

  render(ctx: RegionRenderContext): string[] {
    const data = this.payload;
    if (data === undefined) return [];
    const first = this.panel?.render(ctx.width).slice(0, Math.max(0, ctx.budget - 1)) ?? [];
    const head = this.renderSummary(data, ctx);
    if (!this.expanded) return [head];
    // Summary first so the option numbers stay on screen while reading the
    // body; the body then takes whatever the budget has left.
    const bodyBudget = Math.max(0, ctx.budget - 1);
    return [head, ...first.slice(0, bodyBudget)];
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  hasHiddenContent(): boolean {
    return this.payload !== undefined && !this.expanded;
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

  handleMouse(event: RegionMouseEvent): TuiMouseEventResult | undefined {
    void event;
    return undefined;
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

  /**
   * The always-visible line: what is being asked, and the numbered options.
   * Kept to one truncated row so the fold never pushes the editor off screen.
   */
  private renderSummary(data: ApprovalPanelData, ctx: RegionRenderContext): string {
    const palette = ctx.palette;
    const marker = ctx.focused
      ? chalk.hex(palette.accent).bold('▶')
      : chalk.hex(palette.primary).bold('▶');
    // Prefer the panel's own tool-specific prompt: it is what the expanded
    // form shows, and a generic fallback here would be a second phrasing that
    // drifts from it (and drops the wording the tool provided).
    const label = this.panel?.headerText() ?? data.tool_name;
    const choices = data.choices
      .map((choice, index) => {
        const number = chalk.hex(palette.textDim)(`${index + 1}`);
        const text = index === this.selectedIndex
          ? chalk.hex(palette.accent).bold(choice.label)
          : chalk.hex(palette.textStrong)(choice.label);
        return `${number}.${text}`;
      })
      .join(chalk.hex(palette.textDim)('  '));
    const head = `${marker} ${chalk.hex(palette.primary).bold(label)}  ${choices}`;
    const hint = this.expanded
      ? t('tui.chrome.statusSurface.approval.collapseHint')
      : t('tui.chrome.statusSurface.approval.expandHint');
    return `${head}${chalk.hex(palette.textDim)(`  · ${hint}`)}`;
  }
}

function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
