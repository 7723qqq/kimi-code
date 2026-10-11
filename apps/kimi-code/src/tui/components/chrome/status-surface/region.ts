/**
 * Region contract for the unified status surface.
 *
 * The surface is the single strip between the activity pane and the editor.
 * Everything it draws lives in a region, and every capability the host needs
 * from a panel — measurement, folding, focus, key handling, mouse handling —
 * is expressed here once rather than re-invented per panel.
 *
 * A region also declares *how it wants to be placed* and *what it is*, so the
 * container never has to ask a region's name. The container previously held
 * four of these facts about three known regions (`hasBlockingRegion` looked for
 * `'approval'`, `Ctrl+T` folded `'todo'`, `Ctrl+N` focused `'updates'`, and the
 * scroll fallback read `'todo'`). Adding a fourth region meant editing the
 * container in five places. All of that is region-declared state now, so
 * adding a module is registering an implementation.
 *
 * Memory note: a region does not know the terminal height. The surface reads
 * `terminal.rows` once and hands each region a granted `budget` (see
 * `budget.ts`). A region that measured itself would need to know what the
 * others took, which is the situation this module exists to prevent.
 */

import type { TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';

import type { ColorPalette } from '#/tui/theme/colors';

/**
 * A region's identity. Open on purpose: the container must be able to hold a
 * region it has never heard of.
 */
export type RegionId = string;

/**
 * Where a region wants to be drawn.
 *
 * - `'left'` / `'right'` — share a band with the opposite column.
 * - `'full'` — take a band of its own, spanning both columns.
 *
 * This is how "a diff needs the full width" is expressed. The constraint is
 * real (`approval-panel` renders its diff at `contentWidth = width - 2`, and a
 * half-width diff wraps into noise), and it belongs to the region that has the
 * diff — not to the container, which would otherwise have to know that one
 * particular region is the wide one.
 *
 * A method rather than a field because the answer can depend on state: an
 * approval's folded summary is one line and fits a column, while its expanded
 * body is the diff that needs the whole width.
 */
export type RegionPlacement = 'left' | 'right' | 'full';

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
  | 'toggle'
  | 'digit1'
  | 'digit2'
  | 'digit3'
  | 'digit4'
  | 'digit5'
  | 'digit6'
  | 'digit7'
  | 'digit8'
  | 'digit9';

/**
 * Keys the editor hands to the status surface. A superset of {@link RegionKey}:
 * `focus` is the strip-level request to grab or release panel focus (`Ctrl+N`),
 * and `cycleColumn` moves the keyboard to the other column (`Tab`); neither has
 * a per-region meaning, and both are handled by the surface itself.
 */
export type StatusSurfaceKey = RegionKey | 'focus' | 'cycleColumn';

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

  /** Where this region wants to be drawn. See {@link RegionPlacement}. */
  placement(): RegionPlacement;

  /**
   * Ordering weight. Lower sorts first and is served first by the budget, so a
   * blocking region outranks the informational ones and never gets squeezed to
   * nothing by a long todo list.
   *
   * Declared by the region rather than read from a table the container owns: a
   * table is a place the container has to be edited for every new region.
   */
  readonly priority: number;

  /**
   * Regions this one temporarily replaces while it is present. The container
   * applies the list generically (a suppressed region is skipped for layout,
   * budget and hit testing until the suppressor disappears), so a blocking
   * prompt can take over a sibling's slot without the container knowing either
   * region by name.
   */
  readonly suppresses?: readonly RegionId[];

  /**
   * True while this region is waiting on a decision the user has to make, so
   * the editor must not accept a submission.
   *
   * Defined by behaviour ("there is an unanswered question on screen"), not by
   * the region's name — a future region that asks the user something declares
   * the same thing and gets the same treatment.
   */
  readonly blocking?: boolean;

  /**
   * The region `Ctrl+N` grabs when it moves the keyboard into the strip.
   *
   * One region declares it; `Ctrl+N` is a strip-level gesture and can only
   * mean one target. The container asks "who declared it" instead of naming a
   * region.
   */
  readonly defaultFocusTarget?: boolean;

  /**
   * The region strip-level keys and the click-to-fold fallback act on when
   * nothing is focused: `Ctrl+T` folding and the arrow-key scroll fallback.
   *
   * Both previously hardcoded the same region's id, and both need the same
   * answer to the same question — "with no focus, what does the user mean?"
   * — so they read one declaration.
   */
  readonly defaultKeyTarget?: boolean;

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
   * Whether unfolding right now would reveal rows that are not on screen.
   *
   * This is the *only* fold predicate the surface consults, and the answer
   * must stay true after unfolding when the region is still clipping its body
   * — otherwise the region can be opened but not closed. An earlier
   * implementation asked each panel for an overflow count that did not match
   * what folding revealed.
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

/** Sort a region list into the order the surface renders and budgets. */
export function sortRegions(regions: readonly StatusRegion[]): StatusRegion[] {
  return [...regions].sort((a, b) => a.priority - b.priority);
}

/** The region that declared {@link StatusRegion.defaultFocusTarget}, if any. */
export function defaultFocusRegion(
  regions: readonly StatusRegion[],
): StatusRegion | undefined {
  return regions.find((region) => region.defaultFocusTarget === true);
}

/** The region that declared {@link StatusRegion.defaultKeyTarget}, if any. */
export function defaultKeyRegion(regions: readonly StatusRegion[]): StatusRegion | undefined {
  return regions.find((region) => region.defaultKeyTarget === true);
}
