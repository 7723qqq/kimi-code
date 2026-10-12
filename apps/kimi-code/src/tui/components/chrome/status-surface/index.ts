/**
 * StatusSurface — the single strip between the activity pane and the editor.
 *
 * It replaces the pair of side-by-side panels (`panelsRow`) that used to sit
 * there, plus the approval panel that used to replace the editor entirely.
 * Everything the user needs to see about *the work in progress* now lives in
 * one container, so the things that were previously decided several times are
 * decided once here:
 *
 * - **Frame**: the surface draws the one box the strip lives in — a border, a
 *   rule between stacked units, and one padding cell on each side. Regions
 *   render content, never their own box, which is what keeps a two-region
 *   strip from reading as two stacked boxes. The frame's rows come out of the
 *   same budget the regions divide.
 * - **Height**: {@link computeBudget} divides one budget by region priority.
 *   A region no longer reads `terminal.rows`.
 * - **Focus**: the surface owns `focusedRegionId` and routes keys to it. The
 *   editor has one callback into this component instead of one per panel, and
 *   the focused unit's chrome is the single focus highlight.
 * - **Mouse**: the surface records each region's row rect during `render` and
 *   translates incoming events before handing them over. Clicking a region's
 *   blank space folds it — the same gesture for every region.
 *
 * Regions stack as units; two column regions may share a unit when there is
 * room for both, and anything that needs the full width — a blocking approval,
 * or either column on a narrow terminal — takes a unit of its own.
 */

import {
  type Component,
  compositeTuiLine,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  PANEL_BOTTOM_LEFT,
  PANEL_BOTTOM_RIGHT,
  PANEL_HORIZONTAL,
  PANEL_TEE_LEFT,
  PANEL_TEE_RIGHT,
  PANEL_TOP_LEFT,
  PANEL_TOP_RIGHT,
  PANEL_VERTICAL,
} from '#/tui/constant/panel';
import { currentTheme } from '#/tui/theme';

import { computeBudget, isSurfaceEmpty } from './budget';
import {
  defaultFocusRegion,
  defaultKeyRegion,
  sortRegions,
  type RegionId,
  type RegionKey,
  type RegionMouseEvent,
  type RegionPlacement,
  type StatusRegion,
  type StatusSurfaceKey,
} from './region';

/**
 * The rectangle a region occupied in the last layout, for mouse hit testing.
 *
 * Two-dimensional because two regions can share a row: the left and right
 * columns are drawn side by side, so a row alone does not identify a region.
 */
export interface RegionBox {
  readonly id: RegionId;
  /** Column offset from the left edge of the surface, inclusive. */
  readonly col: number;
  /** Width of the region's box. */
  readonly width: number;
  /** Row offset from the top of the surface's output, inclusive. */
  readonly from: number;
  /**
   * Row offset one past the *band's* last row, which is not the region's last
   * row when it shares the band with a taller neighbour. The band is the unit
   * of height; the region's own rows are {@link drawn}.
   */
  readonly bandTo: number;
  /**
   * Rows the region actually painted, which can be fewer than the band's
   * height when it shares a row with a taller neighbour.
   *
   * Hit testing stops here: the box is the band's, but the rows below this are
   * blank space the region never drew, and a click there is not a click on it.
   */
  readonly drawn: number;
}

/**
 * A region that reports the row cost it has at `width`.
 *
 * The surface measures a region at the width it is about to be painted at,
 * which is not the surface's own width once the strip is split into columns.
 * Wrapping is the only change needed — the region keeps its id, its declared
 * placement, and every other answer, so the budget pass still sorts and serves
 * the region it was handed.
 *
 * For measurement only: the proxy answers `measure` at one width and forwards
 * everything else. It must never be stored, and nothing may write through it —
 * the surface keeps the original objects in `regions`.
 */
function measureAt(region: StatusRegion, width: number): StatusRegion {
  // A proxy, not a spread: spreading a class instance copies own fields and
  // drops the prototype, so every method would come back undefined.
  return new Proxy(region, {
    get(target, property) {
      if (property === 'measure') return () => target.measure(width);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** One stacked band: the regions sharing a row, and the rows they take. */
interface PlannedUnit {
  /** Row offset from the top of the surface's output, inclusive. */
  readonly from: number;
  /** Rows the unit occupies, the separating rule excluded. */
  readonly height: number;
  readonly boxes: readonly RegionBox[];
  /**
   * Column of the vertical divider when the unit is the strip's two halves,
   * `undefined` for every other unit. Drawn even while one half is empty, so
   * the right half reads as the updates panel's permanent slot.
   */
  readonly divider?: number;
}

/** A unit as planned before the budget decides what actually gets rows. */
interface UnitSpec {
  readonly members: readonly {
    readonly region: StatusRegion;
    readonly column: 'left' | 'right' | 'full';
  }[];
  readonly priority: number;
  /** True for the unit whose halves are the strip's fixed layout. */
  readonly columns?: boolean;
}

/**
 * The last layout: the units to paint, and every region's rectangle for hit
 * testing. Both come out of one pass so they cannot disagree.
 */
interface SurfacePlan {
  readonly boxes: readonly RegionBox[];
  readonly units: readonly PlannedUnit[];
}

export interface StatusSurfaceOptions {
  /** Terminal rows; the surface is the only reader of this. */
  readonly terminalRows?: () => number;
  /** Called after any state change that should repaint. */
  readonly onRequestRender?: () => void;
}

/** Gap between the two columns, in cells. */
export const COLUMN_GAP = 1;

/**
 * Narrowest a single column may get before the two columns stop being worth
 * it. The updates panel wraps its body into the width it is handed minus its
 * own indent, and the todo panel draws a fixed ten-cell status bar plus a
 * five-cell braille bar, below which both wrap into something unreadable.
 */
export const MIN_COLUMN_WIDTH = 30;

/** Below this the surface stacks instead of splitting. */
export const MIN_SPLIT_WIDTH = MIN_COLUMN_WIDTH * 2 + COLUMN_GAP;

/**
 * Rows the surface spends on its own frame: the top and bottom borders. Every
 * pair of stacked units adds one more for the rule between them.
 */
export const SURFACE_FRAME_ROWS = 2;

/** One cell of padding between the frame and a region's content. */
export const SURFACE_SIDE_PADDING = 1;

/**
 * Cells the frame and its padding take off every row: the two border columns
 * plus one padding cell on each side. Regions are measured and drawn inside
 * what is left, so nothing a region renders can land on the frame.
 */
export const SURFACE_INSET = 2 + SURFACE_SIDE_PADDING * 2;

/**
 * Split the surface's width into a left and a right column.
 *
 * Fixed at half each rather than sized to content: `allocateStackSizes` with
 * `basis: 'auto'` distributes by intrinsic width, and the updates box's
 * intrinsic width changes with every entry, so a column that grew with its
 * content would re-flow its neighbour on every update. Half-and-half keeps the
 * split still while content moves under it.
 *
 * Returns a single full-width column when there is no room for two.
 */
export function splitColumns(width: number): readonly [
  { readonly col: number; readonly width: number },
  { readonly col: number; readonly width: number },
  { readonly col: number; readonly width: number },
] {
  const full = { col: 0, width };
  if (width < MIN_SPLIT_WIDTH) {
    return [full, full, full];
  }
  const right = Math.floor((width - COLUMN_GAP) / 2);
  const left = width - COLUMN_GAP - right;
  return [
    { col: 0, width: left },
    { col: left + COLUMN_GAP, width: right },
    full,
  ];
}

export class StatusSurfaceComponent implements Component {
  private readonly regions = new Map<RegionId, StatusRegion>();
  private readonly terminalRows: () => number;
  private readonly onRequestRender: () => void;
  private focusedRegionId: RegionId | null = null;
  /** Boxes from the last layout; empty until the first `render`. */
  private rects: readonly RegionBox[] = [];

  constructor(options: StatusSurfaceOptions = {}) {
    this.terminalRows = options.terminalRows ?? (() => 0);
    this.onRequestRender = options.onRequestRender ?? (() => {});
  }

  /**
   * Register or replace a region.
   *
   * `autoFocus` is honoured on every registration, not just the first: the
   * approval region declares it and arrives long after startup (when a request
   * comes in), so gating this on "the region was already there" would leave an
   * approval on screen without the keyboard.
   *
   * Replacing keeps the previous region's fold state out of the picture on
   * purpose: a new region instance is a new piece of content, and carrying a
   * stale expansion over is how the Updates box used to open pre-scrolled into
   * an unrelated entry.
   */
  setRegion(region: StatusRegion): void {
    // The surface supplies the change signal, so a region never holds its own
    // callback and cannot report a change without also getting the repaint and
    // the focus re-evaluation that must accompany it.
    region.onChange = () => this.handleRegionChange(region.id);
    this.regions.set(region.id, region);
    if (region.autoFocus === true && !region.isEmpty()) {
      this.focusRegion(region.id);
      return;
    }
    if (this.focusedRegionId !== null && this.regions.get(this.focusedRegionId)?.isEmpty() === true) {
      this.focusRegion(null);
    }
  }

  /** Regions in render order (highest priority first). */
  private orderedRegions(): readonly StatusRegion[] {
    const present = [...this.regions.values()].filter((region) => !region.isEmpty());
    // A present region may take over a sibling's slot (an approval replaces the
    // todo list while it waits for an answer). The suppressed region is skipped
    // for ordering, budget and hit testing until the suppressor is gone; the
    // declaration lives on the region, so the container stays name-agnostic.
    const suppressed = new Set<RegionId>();
    for (const region of present) {
      for (const id of region.suppresses ?? []) suppressed.add(id);
    }
    return sortRegions(present.filter((region) => !suppressed.has(region.id)));
  }

  isEmpty(): boolean {
    return isSurfaceEmpty([...this.regions.values()]);
  }

  /**
   * Whether a region is waiting on the user and the editor should not accept
   * a submission. The host consults this instead of the editor-replacement
   * flag, which used to be the only signal an approval was up.
   *
   * Asked of the regions rather than of one region's id: "blocking" is a
   * behaviour a region declares, so a future region that asks the user
   * something is covered without the container learning a new name.
   */
  hasBlockingRegion(): boolean {
    for (const region of this.regions.values()) {
      if (region.blocking === true && !region.isEmpty()) return true;
    }
    return false;
  }

  focusedRegion(): RegionId | null {
    return this.focusedRegionId;
  }

  /**
   * One region's content changed: repaint, and move the keyboard if the region
   * asks for it.
   *
   * A region is registered once (at startup) and becomes non-empty later, which
   * the surface cannot observe on its own. This is the single place that reacts
   * to that, so a region reports "I changed" and the surface decides both what
   * to redraw and whether the keyboard belongs here — an approval that appeared
   * without taking focus would be visible but not answerable.
   */
  private handleRegionChange(id: RegionId): void {
    const region = this.regions.get(id);
    if (region !== undefined && region.autoFocus === true && !region.isEmpty()) {
      this.focusRegion(id);
    }
    this.onRequestRender();
  }

  /** Move focus to a region (or clear it). Returns whether anything changed. */
  focusRegion(id: RegionId | null): boolean {
    if (id !== null) {
      const region = this.regions.get(id);
      if (region === undefined || region.isEmpty()) return false;
    }
    if (this.focusedRegionId === id) return false;
    const previous = this.focusedRegionId === null ? undefined : this.regions.get(this.focusedRegionId);
    this.focusedRegionId = id;
    previous?.onBlur?.();
    if (id !== null) this.regions.get(id)?.onFocus?.();
    return true;
  }

  /**
   * Handle a key the editor passed up. Returns true when a region consumed it;
   * false means the caller should fall through to the editor's own binding,
   * which is what keeps an idle Ctrl+T harmless.
   */
  handleKey(key: RegionKey): boolean {
    if (key === 'escape') {
      if (this.focusedRegionId === null) return false;
      this.focusRegion(null);
      this.onRequestRender();
      return true;
    }
    const focused = this.focusedRegionId === null ? undefined : this.regions.get(this.focusedRegionId);
    if (focused !== undefined && focused.handleKey?.(key) === true) {
      this.onRequestRender();
      return true;
    }
    if (key === 'toggle') return this.toggleFoldOf(this.defaultKeyRegion());
    if (key === 'up' || key === 'down') return this.scrollFocused(key === 'up' ? -1 : 1);
    // ←/→ are already answered above by the focused region, which is the only
    // thing that knows its own horizontal vocabulary — the left column steps
    // through an approval's options, the right one walks the updates channels.
    // Asking again here would be a second step for one keypress.
    return false;
  }

  /**
   * The region strip-level gestures act on when nothing is focused.
   *
   * `Ctrl+T` and the arrow-key scroll fallback both used to name the same
   * region's id; both are answering "with no focus, what does the user mean?",
   * so they ask the same question and get the region that declared itself the
   * answer.
   */
  private defaultKeyRegion(): StatusRegion | undefined {
    return defaultKeyRegion([...this.regions.values()]);
  }

  /**
   * Entry point for the editor. `focus` is the strip-level request (`Ctrl+N`):
   * it moves the keyboard to the updates region, or releases it back to the
   * editor. Everything else is delegated to whichever region owns focus.
   *
   * Returns `false` when nothing changed, which is how the editor knows to run
   * its own binding for the key instead of silently swallowing it.
   */
  handleStatusSurfaceKey(key: StatusSurfaceKey): boolean {
    if (key === 'focus') return this.toggleFocus();
    if (key === 'cycleColumn') return this.cycleColumnFocus();
    return this.handleKey(key);
  }

  /**
   * Hand a raw key to the focused region before the editor's own mapping.
   *
   * Returns true when the focused region consumed it; false — no focus, or the
   * region has no use for this key — means the caller should continue with its
   * own binding. This is the only route by which a panel receives printable
   * text and its own Ctrl shortcuts.
   */
  handleRawInput(data: string): boolean {
    const focused = this.focusedRegionId === null ? undefined : this.regions.get(this.focusedRegionId);
    if (focused === undefined) return false;
    if (focused.handleRawInput?.(data) !== true) return false;
    this.onRequestRender();
    return true;
  }

  /**
   * Move the keyboard to the other column of the strip (`Tab`).
   *
   * Only a strip-level gesture: it needs the geometry, which is the one thing
   * a region cannot see. Which region in the target column gets the keyboard is
   * decided by the surface's own ordering, not by name.
   *
   * Returns false when the strip has no focus to move or there is nowhere to
   * move it to, so the editor keeps its own Tab binding in the common case.
   */
  cycleColumnFocus(): boolean {
    if (this.focusedRegionId === null) return false;
    const current = this.regions.get(this.focusedRegionId);
    if (current === undefined) return false;
    const from = current.placement();
    const ordered = this.orderedRegions();
    // From a full-width region the target is the first column with something in
    // it — not "nowhere". An approval is both full-width and auto-focused, so
    // answering "no neighbour" here would trap the keyboard in the approval for
    // as long as it was up: Escape rejects, and Tab would do nothing at all.
    const wanted: readonly RegionPlacement[] =
      from === 'full' ? ['left', 'right'] : [from === 'left' ? 'right' : 'left'];
    const target = ordered.find(
      (region) =>
        !region.isEmpty() &&
        region.id !== this.focusedRegionId &&
        wanted.includes(region.placement()),
    );
    if (target === undefined) return false;
    if (!this.focusRegion(target.id)) return false;
    this.onRequestRender();
    return true;
  }

  /**
   * Move focus into the strip's declared focus target, or release it back to
   * the editor.
   *
   * Both directions go through {@link focusRegion} so the region's own focus
   * mirror stays in step: an earlier version set only one of the two flags and
   * the panel highlighted its border while the keys went nowhere.
   */
  toggleFocus(): boolean {
    if (this.focusedRegionId !== null) {
      if (!this.focusRegion(null)) return false;
      this.onRequestRender();
      return true;
    }
    const target = defaultFocusRegion([...this.regions.values()]);
    if (target === undefined) return false;
    if (!this.focusRegion(target.id)) return false;
    this.onRequestRender();
    return true;
  }

  /**
   * Fold or unfold a region, but only when doing so reveals or hides
   * something. The predicate is the region's own `hasHiddenContent`, not a
   * count of items: the todo panel used to gate this on `items > 5`, which is
   * unrelated to how many rows folding actually adds, so a five-item tree
   * advertised "ctrl+t to expand" and then swallowed the key.
   */
  toggleFold(id: RegionId): boolean {
    return this.toggleFoldOf(this.regions.get(id));
  }

  private toggleFoldOf(region: StatusRegion | undefined): boolean {
    if (region === undefined || region.isEmpty()) return false;
    if (!region.isExpanded()) {
      region.setExpanded(true);
      this.onRequestRender();
      return true;
    }
    if (!region.hasHiddenContent()) return false;
    region.setExpanded(false);
    this.onRequestRender();
    return true;
  }

  /** Scroll the focused region, falling back to the declared default. */
  private scrollFocused(delta: number): boolean {
    const key: RegionKey = delta < 0 ? 'up' : 'down';
    const focused = this.focusedRegionId === null ? undefined : this.regions.get(this.focusedRegionId);
    if (focused?.handleKey?.(key) === true) {
      this.onRequestRender();
      return true;
    }
    const fallback = this.defaultKeyRegion();
    // The declared default is also the focused region whenever the user just
    // grabbed the strip with Ctrl+N, and asking it the same key twice would
    // scroll two steps for one keypress.
    if (fallback === undefined || fallback === focused) return false;
    if (fallback.handleKey?.(key) === true) {
      this.onRequestRender();
      return true;
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.rects.length === 0) return undefined;
    // Two regions can share a row, so the row alone does not identify one: the
    // column has to match too. When the split collapsed to a single column both
    // boxes span the full width and the first match wins, which is the stacked
    // behaviour.
    // `from + drawn`, not `to`: a region sharing a row with a taller neighbour
    // owns only the rows it painted. The rest of the band is blank space, and
    // a click there must fall through — otherwise the shorter column grows a
    // dead strip below itself that folds it when clicked.
    const rect = this.rects.find(
      (entry) =>
        entry.drawn > 0 &&
        event.y >= entry.from &&
        event.y < entry.from + entry.drawn &&
        event.x >= entry.col &&
        event.x < entry.col + entry.width,
    );
    if (rect === undefined) {
      return undefined;
    }
    const region = this.regions.get(rect.id);
    if (region === undefined) return undefined;

    const local: RegionMouseEvent = {
      type: event.type,
      button: event.button,
      x: event.x - rect.col,
      y: event.y - rect.from,
      wheelDelta: event.wheelDelta ?? 0,
      clickCount: event.clickCount ?? 0,
      shift: event.shift,
      alt: event.alt,
      ctrl: event.ctrl,
      raw: { ...event, x: event.x - rect.col, y: event.y - rect.from },
    };

    const handled = region.handleMouse?.(local);
    if (handled !== undefined && handled.handled !== false) {
      return { ...handled, handled: true };
    }

    if (event.type === 'click' && event.button === 'left') {
      // Focus is only a reason to consume the click when it actually moved.
      //
      // The old code returned `handled: true` as soon as `wantsFocus()` was
      // true, without checking whether the focus had moved — so a region that
      // already owned the keyboard (an approval, which is `autoFocus`) ate
      // every click, changed nothing, and never reached the fold below. That
      // is why the approval prompt could be seen but not answered: the one
      // blocking interaction in the app was the one thing a click could not
      // touch.
      // Focus first, and stop there when it moved: the first click on a folded
      // region takes the keyboard, the second one unfolds it. Doing both at once
      // would make a click that only meant "give me the keys" also resize the
      // strip under the pointer.
      if (region.wantsFocus?.(local) === true && this.focusRegion(rect.id)) {
        this.onRequestRender();
        return { handled: true, focus: true, render: true };
      }
      // Focus did not move — either the region already had it or it does not
      // want it — so the click falls through to folding. This is the branch the
      // old code never reached while `wantsFocus` was true, which is why an
      // already-focused approval swallowed every click and could not be opened.
      if (this.toggleFold(rect.id)) {
        this.onRequestRender();
        return { handled: true, render: true };
      }
    }

    if (event.type === 'wheel' && local.wheelDelta !== 0) {
      const key: RegionKey = local.wheelDelta < 0 ? 'up' : 'down';
      const steps = Math.max(1, Math.abs(local.wheelDelta));
      let moved = false;
      for (let step = 0; step < steps; step += 1) {
        if (region.handleKey?.(key) === true) moved = true;
      }
      if (moved) {
        this.onRequestRender();
        return { handled: true, render: true };
      }
    }

    return undefined;
  }

  invalidate(): void {
    for (const region of this.regions.values()) {
      (region as StatusRegion & { invalidate?: () => void }).invalidate?.();
    }
  }

  render(width: number): string[] {
    return this.paint(this.layout(width), width);
  }

  /**
   * Where every region goes at this width, and how tall each stacked unit is.
   *
   * Produced once and read by both `render` and `handleMouse`, so the drawing
   * and the hit testing cannot disagree. They previously were two independent
   * computations kept in step by hand — `render` accumulated row offsets as it
   * painted and `handleMouse` compared against that by-product — which is how
   * an approval could be on screen and still unclickable: the fold the paint
   * knew about was not the one the click reached.
   *
   * A *unit* is one horizontal band. A full-width region takes a unit of its
   * own; every other region shares one: the strip's right half is the updates
   * panel's permanent slot, and the left half stacks whatever else is present
   * (the todo list, a pending approval). On a terminal too narrow for two
   * columns the halves collapse and each region becomes its own unit. Units
   * stack vertically and a rule separates each pair of neighbours. The frame
   * and those rules are paid for out of the same row budget the regions
   * divide, so the whole strip can never ask the terminal for more rows than
   * `surfaceTotalRows` allows.
   */
  private layout(width: number): SurfacePlan {
    const ordered = this.orderedRegions();
    if (ordered.length === 0) return { boxes: [], units: [] };
    const innerWidth = Math.max(1, width - SURFACE_INSET);
    const cols = splitColumns(innerWidth);
    const split = innerWidth >= MIN_SPLIT_WIDTH;

    // Which half a region stacks in is its own declaration; a collapsed split
    // sends everything down the full-width path.
    const columnOf = (region: StatusRegion): { col: number; width: number } => {
      if (!split || region.placement() === 'full') return cols[2];
      return cols[region.placement() === 'right' ? 1 : 0];
    };

    const specs: UnitSpec[] = [];
    if (split) {
      // A full-width region keeps a band of its own. Nothing in the strip
      // declares `'full'` today, but the capability stays for a region that
      // needs the whole width.
      for (const region of ordered) {
        if (region.placement() === 'full') {
          specs.push({ members: [{ region, column: 'full' }], priority: region.priority });
        }
      }
      const halves = ordered.filter((region) => region.placement() !== 'full');
      if (halves.length > 0) {
        specs.push({
          members: halves.map((region) => ({
            region,
            column: region.placement() === 'right' ? ('right' as const) : ('left' as const),
          })),
          priority: Math.min(...halves.map((region) => region.priority)),
          columns: true,
        });
      }
    } else {
      // Too narrow for two columns: every region takes its own unit so the
      // collapsed halves stack instead of painting over each other.
      for (const region of ordered) {
        specs.push({ members: [{ region, column: 'full' }], priority: region.priority });
      }
    }
    // Priority decides what a short budget serves first; the on-screen order of
    // the units follows it.
    specs.sort((a, b) => a.priority - b.priority);

    // Measure at the width each region is actually going to be drawn at. A
    // region measured at the full width but painted into a column reports the
    // wrong height: the updates panel wraps more at 39 columns than at 80, and
    // the budget that came from the wider measurement then leaves too few rows
    // for the box to close.
    const budget = computeBudget(
      this.terminalRows(),
      ordered.map((region) => measureAt(region, columnOf(region).width)),
      width,
      SURFACE_FRAME_ROWS + Math.max(0, specs.length - 1),
    );
    const grants = new Map(
      [...budget.perRegion].map(([id, rows]) => [id, rows] as const),
    );

    const boxes: RegionBox[] = [];
    const planned: PlannedUnit[] = [];
    // Row 0 is the frame's top border; units and their separating rules follow.
    let row = 1;
    for (const spec of specs) {
      const members = spec.members
        .map((member) => ({ ...member, granted: grants.get(member.region.id) ?? 0 }))
        .filter((member) => member.granted > 0);
      if (members.length === 0) continue;
      // The rule between two drawn units costs a row of its own.
      if (planned.length > 0) row += 1;

      // Each half stacks its own members. The unit is as tall as the taller
      // half, and the shorter one simply ends earlier — which is why the hit
      // test below looks at what each region painted, not at the unit.
      const stacked = new Map<'left' | 'right' | 'full', number>();
      for (const member of members) {
        stacked.set(member.column, (stacked.get(member.column) ?? 0) + member.granted);
      }
      const height = Math.max(0, ...stacked.values());

      const offsets = new Map<'left' | 'right' | 'full', number>();
      const unitBoxes: RegionBox[] = [];
      for (const member of members) {
        const offset = offsets.get(member.column) ?? 0;
        const box = columnOf(member.region);
        unitBoxes.push({
          id: member.region.id,
          col: SURFACE_SIDE_PADDING + 1 + box.col,
          width: box.width,
          from: row + offset,
          bandTo: row + offset + member.granted,
          drawn: member.granted,
        });
        offsets.set(member.column, offset + member.granted);
      }
      boxes.push(...unitBoxes);
      planned.push({
        from: row,
        height,
        boxes: unitBoxes,
        // The two halves are a fixture of the strip, so the divider stands
        // even while the updates half has nothing in it.
        divider: spec.columns === true ? SURFACE_SIDE_PADDING + 1 + cols[0].width : undefined,
      });
      row += height;
    }
    return { boxes, units: planned };
  }

  private paint(plan: SurfacePlan, width: number): string[] {
    if (plan.units.length === 0) {
      this.rects = [];
      return [];
    }
    // The frame needs its two border columns; a host that hands over even less
    // than that gets a strip it cannot read rather than one wider than itself.
    const safeWidth = Math.max(2, width);
    const palette = currentTheme.palette;
    const painted = new Map<RegionId, number>();
    const lines: string[] = [];
    /** The last unit's painter, so the strip's bottom edge closes its box. */
    let paintBottom = (text: string): string => chalk.hex(palette.border)(text);

    for (const [index, unit] of plan.units.entries()) {
      // The unit that owns the keyboard paints its chrome in the focus colour:
      // a per-region highlight would be a second voice for one fact, and this
      // frame is the only chrome the strip still draws.
      const focused = unit.boxes.some((box) => box.id === this.focusedRegionId);
      const paint = (text: string): string =>
        chalk.hex(focused ? palette.borderFocus : palette.border)(text);
      paintBottom = paint;
      lines.push(
        index === 0
          ? this.rule(PANEL_TOP_LEFT, PANEL_TOP_RIGHT, safeWidth, paint)
          : this.rule(PANEL_TEE_LEFT, PANEL_TEE_RIGHT, safeWidth, paint),
      );
      for (let offset = 0; offset < unit.height; offset += 1) {
        lines.push(this.contentRow(safeWidth, unit.divider, paint));
      }
      for (const box of unit.boxes) {
        const region = this.regions.get(box.id);
        if (region === undefined) continue;
        const granted = box.bandTo - box.from;
        // Regions draw content, not boxes: the frame, the padding and the rule
        // between units all belong to the surface, which is what keeps the
        // strip to one frame no matter how many regions are present.
        const body = region
          .render({
            width: box.width,
            budget: granted,
            focused: this.focusedRegionId === box.id,
            palette,
          })
          .slice(0, granted);
        for (let offset = 0; offset < body.length; offset += 1) {
          const target = box.from + offset;
          const line = truncateToWidth(body[offset]!, box.width);
          // Composited rather than written outright: the frame's side bars and
          // the column divider live in the same row, and overwriting the row
          // would take them with it.
          lines[target] = truncateToWidth(
            compositeTuiLine(lines[target]!, line, box.col, box.width, safeWidth),
            safeWidth,
          );
        }
        // Remember what this region drew, not what the unit reserved for it: a
        // shorter half's blank tail belongs to the unit, not to the region.
        painted.set(box.id, body.length);
      }
    }
    // The bottom edge closes the last unit's box, so it follows that unit's
    // chrome — including its focus colour. Painting it with the resting border
    // unconditionally is what left the strip's bottom row as the one line that
    // did not follow the rest when a focused region (an approval) was up.
    lines.push(this.rule(PANEL_BOTTOM_LEFT, PANEL_BOTTOM_RIGHT, safeWidth, paintBottom));
    // The boxes come back with what was painted, so a later hit test reads the
    // region's own rows rather than the unit's.
    this.rects = plan.boxes.map((box) => ({ ...box, drawn: painted.get(box.id) ?? 0 }));
    return lines;
  }

  /** One horizontal rule of the frame, corners included. */
  private rule(
    left: string,
    right: string,
    width: number,
    paint: (text: string) => string,
  ): string {
    return paint(left + PANEL_HORIZONTAL.repeat(Math.max(0, width - 2)) + right);
  }

  /** A content row: the frame's side bars, its padding, and an optional divider. */
  private contentRow(
    width: number,
    dividerCol: number | undefined,
    paint: (text: string) => string,
  ): string {
    const body = Math.max(0, width - 2);
    if (dividerCol === undefined) {
      return paint(PANEL_VERTICAL) + ' '.repeat(body) + paint(PANEL_VERTICAL);
    }
    // Keep the divider inside the interior when a caller hands a width too
    // small for the two columns it asked for.
    const offset = Math.max(0, Math.min(body - 1, dividerCol - 1));
    return (
      paint(PANEL_VERTICAL) +
      ' '.repeat(offset) +
      paint(PANEL_VERTICAL) +
      ' '.repeat(Math.max(0, body - offset - 1)) +
      paint(PANEL_VERTICAL)
    );
  }

  /** Boxes from the last layout; read by tests to place mouse events. */
  regionRects(): readonly RegionBox[] {
    return this.rects;
  }

}
