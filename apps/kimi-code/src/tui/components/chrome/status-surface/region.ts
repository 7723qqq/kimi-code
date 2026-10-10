/**
 * Region contract for the unified status surface.
 *
 * The surface is the single strip between the activity pane and the editor.
 * Everything it draws lives in a region, and every capability the host needs
 * from a panel — measurement, folding, focus, key handling, mouse handling —
 * is expressed here once rather than re-invented per panel.
 *
 * Memory note: a region does not know the terminal height. The surface reads
 * `terminal.rows` once and hands each region a granted `budget` (see
 * `budget.ts`). A region that measured itself would need to know what the
 * others took, which is the situation this module exists to prevent.
 */

import type { TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';

import type { ColorPalette } from '#/tui/theme/colors';

export type RegionId = 'approval' | 'todo' | 'updates';

/**
 * Region ordering. Lower sorts first and is served first by the budget, so a
 * blocking region (an approval waiting on the user) outranks the informational
 * ones and never gets squeezed to nothing by a long todo list.
 */
export const REGION_PRIORITY: Readonly<Record<RegionId, number>> = {
  approval: 0,
  todo: 10,
  updates: 20,
};

/** Keys the surface routes to whichever region currently owns focus. */
export type RegionKey =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'enter'
  | 'escape'
  | 'toggle';

/**
 * Keys the editor hands to the status surface. A superset of {@link RegionKey}:
 * `focus` is the strip-level request to grab or release panel focus (`Ctrl+N`),
 * which has no per-region meaning and is handled by the surface itself.
 */
export type StatusSurfaceKey = RegionKey | 'focus';

export interface RegionRenderContext {
  /** Full width available to the region, chrome already subtracted. */
  readonly width: number;
  /** Rows this region may occupy, border and hint line included. */
  readonly budget: number;
  /** True while this region owns the keyboard. */
  readonly focused: boolean;
  readonly palette: ColorPalette;
}

/**
 * Mouse event in region-local coordinates. The surface translates the
 * terminal coordinates it received and keeps the original around, because a
 * region may want absolute rows (the Updates tab strip does) or may pass the
 * event further down to a nested component that expects the untranslated one.
 */
export interface RegionMouseEvent {
  readonly type: TuiMouseEvent['type'];
  readonly button: TuiMouseEvent['button'];
  /** Column within the region, `0` at its left edge. */
  readonly x: number;
  /** Row within the region, `0` at its top edge. */
  readonly y: number;
  readonly wheelDelta: number;
  readonly clickCount: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  /** The event as the surface received it, for delegating to nested children. */
  readonly raw: TuiMouseEvent;
}

export interface StatusRegion {
  readonly id: RegionId;

  /** True when the region has nothing to show and must not occupy rows. */
  isEmpty(): boolean;

  /**
   * Rows the region would like at this width, chrome included. The surface
   * clamps the result against the remaining budget; a region is expected to
   * over-report rather than guess, because the clamp is where sharing happens.
   */
  measure(width: number): number;

  /** Draw at most `budget` rows. Implementations must honour the limit. */
  render(ctx: RegionRenderContext): string[];

  /**
   * Folding. All three regions implement the full set — the surface's
   * click-to-fold, `Ctrl+T`, and the footer hint all read the same three
   * methods, so a region that only implements `setExpanded` silently drops
   * out of every one of those paths.
   */
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;

  /**
   * Whether folding currently hides something. This is the *only* fold
   * predicate the surface consults: an earlier implementation asked each
   * panel for an overflow count that did not match what folding revealed.
   */
  hasHiddenContent(): boolean;

  /** Keyboard, delivered only while the region owns focus. */
  handleKey?(key: RegionKey): boolean;

  /** Mouse, in region-local coordinates. */
  handleMouse?(event: RegionMouseEvent): TuiMouseEventResult | undefined;

  /**
   * Whether a click should move focus here. A region that just answers keys
   * (the todo list toggles with Ctrl+T) returns false and keeps the editor's
   * focus; a region the user pages through returns true.
   */
  wantsFocus?(event: RegionMouseEvent): boolean;

  /**
   * Take focus when the region appears without the user asking. Used by the
   * approval region, which must own the keyboard the moment it arrives.
   */
  readonly autoFocus?: boolean;

  /**
   * Focus entering and leaving this region. The surface is the single owner of
   * "which region has the keyboard" — it calls these so a region can mirror
   * that state into whatever it renders (the Updates box highlights its border
   * while focused). A region that kept its own focus flag instead would drift
   * from the surface's, and the keys would go to a panel that does not look
   * focused.
   */
  onFocus?(): void;
  onBlur?(): void;

  /**
   * The region's content changed. The surface repaints and re-evaluates
   * whether the keyboard should move here.
   *
   * One signal, not two: a region that had to remember to both repaint and ask
   * for focus could forget one, and while the two were separate callbacks the
   * approval path had to call them in the right order to be answerable at all.
   * The surface owns both decisions, so it needs to be told only that something
   * changed.
   */
  onChange?(): void;
}

export function regionPriority(id: RegionId): number {
  return REGION_PRIORITY[id];
}

/** Sort a region list into the order the surface renders and budgets. */
export function sortRegions(regions: readonly StatusRegion[]): StatusRegion[] {
  return [...regions].sort((a, b) => regionPriority(a.id) - regionPriority(b.id));
}
