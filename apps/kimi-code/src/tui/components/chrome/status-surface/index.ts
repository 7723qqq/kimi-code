/**
 * StatusSurface — the single strip between the activity pane and the editor.
 *
 * It replaces the pair of side-by-side panels (`panelsRow`) that used to sit
 * there, plus the approval panel that used to replace the editor entirely.
 * Everything the user needs to see about *the work in progress* now lives in
 * one container, so three things that were previously decided three times are
 * decided once here:
 *
 * - **Height**: {@link computeBudget} divides one budget by region priority.
 *   A region no longer reads `terminal.rows`.
 * - **Focus**: the surface owns `focusedRegionId` and routes keys to it. The
 *   editor has one callback into this component instead of one per panel.
 * - **Mouse**: the surface records each region's row rect during `render` and
 *   translates incoming events before handing them over. Clicking a region's
 *   blank space folds it — the same gesture for every region.
 *
 * Layout is vertical (regions stack) rather than horizontal (columns). The
 * side-by-side arrangement could not work once a blocking approval joined the
 * row: a long diff needs the full width, and columns force both neighbours to
 * re-flow whenever either grows.
 */

import { type Component, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { computeBudget, isSurfaceEmpty } from './budget';
import {
  sortRegions,
  type RegionId,
  type RegionKey,
  type RegionMouseEvent,
  type StatusRegion,
  type StatusSurfaceKey,
} from './region';

/** Rows a region occupied in the last paint, for mouse hit testing. */
interface RegionRect {
  readonly id: RegionId;
  /** Row offset from the top of the surface's output, inclusive. */
  readonly from: number;
  /** Row offset one past the region's last row. */
  readonly to: number;
}

export interface StatusSurfaceOptions {
  /** Terminal rows; the surface is the only reader of this. */
  readonly terminalRows?: () => number;
  /** Called after any state change that should repaint. */
  readonly onRequestRender?: () => void;
}

export class StatusSurfaceComponent implements Component {
  private readonly regions = new Map<RegionId, StatusRegion>();
  private readonly terminalRows: () => number;
  private readonly onRequestRender: () => void;
  private focusedRegionId: RegionId | null = null;
  /** Row rects from the last paint; empty until the first `render`. */
  private rects: readonly RegionRect[] = [];

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
    return sortRegions(
      [...this.regions.values()].filter((region) => !region.isEmpty()),
    );
  }

  isEmpty(): boolean {
    return isSurfaceEmpty([...this.regions.values()]);
  }

  /**
   * Whether a region is waiting on the user and the editor should not accept
   * a submission. The host consults this instead of the editor-replacement
   * flag, which used to be the only signal an approval was up.
   */
  hasBlockingRegion(): boolean {
    const approval = this.regions.get('approval');
    if (approval !== undefined && !approval.isEmpty()) return true;
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
    if (key === 'toggle') return this.toggleFold('todo');
    if (key === 'up' || key === 'down') return this.scrollFocused(key === 'up' ? -1 : 1);
    return false;
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
    return this.handleKey(key);
  }

  /**
   * Move focus into the updates region, or release it back to the editor.
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
    if (!this.focusRegion('updates')) return false;
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
    const region = this.regions.get(id);
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

  /** Scroll the focused region, falling back to the todo list. */
  private scrollFocused(delta: number): boolean {
    const key: RegionKey = delta < 0 ? 'up' : 'down';
    const focused = this.focusedRegionId === null ? undefined : this.regions.get(this.focusedRegionId);
    if (focused?.handleKey?.(key) === true) {
      this.onRequestRender();
      return true;
    }
    const todo = this.regions.get('todo');
    if (todo?.handleKey?.(key) === true) {
      this.onRequestRender();
      return true;
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.rects.length === 0) return undefined;
    const rect = this.rects.find((entry) => event.y >= entry.from && event.y < entry.to);
    if (rect === undefined) {
      return undefined;
    }
    const region = this.regions.get(rect.id);
    if (region === undefined) return undefined;

    const local: RegionMouseEvent = {
      type: event.type,
      button: event.button,
      x: event.x,
      y: event.y - rect.from,
      wheelDelta: event.wheelDelta ?? 0,
      clickCount: event.clickCount ?? 0,
      shift: event.shift,
      alt: event.alt,
      ctrl: event.ctrl,
      raw: { ...event, y: event.y - rect.from },
    };

    const handled = region.handleMouse?.(local);
    if (handled !== undefined && handled.handled !== false) {
      return { ...handled, handled: true };
    }

    if (event.type === 'click' && event.button === 'left') {
      if (region.wantsFocus?.(local) === true) {
        if (this.focusRegion(rect.id)) this.onRequestRender();
        return { handled: true, focus: true, render: true };
      }
      if (this.toggleFold(rect.id)) return { handled: true, render: true };
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
    const ordered = this.orderedRegions();
    if (ordered.length === 0) {
      this.rects = [];
      return [];
    }
    const palette = currentTheme.palette;
    const budget = computeBudget(this.terminalRows(), ordered, width);

    const lines: string[] = [];
    const rects: RegionRect[] = [];
    for (const region of ordered) {
      const granted = budget.perRegion.get(region.id) ?? 0;
      if (granted <= 0) continue;
      // Regions self-delimit: the todo panel opens with a rule, the Updates
      // box with the top border that carries its tab strip, and the approval
      // panel with its own header rule. The surface deliberately draws no
      // rules of its own — a second line above a region that already has one
      // reads as a double border, and only the region knows whether its top
      // line is decoration or controls.
      const from = lines.length;
      const body = region.render({
        width,
        budget: granted,
        focused: this.focusedRegionId === region.id,
        palette,
      });
      lines.push(...body.slice(0, granted).map((line) => truncateToWidth(line, width)));
      rects.push({ id: region.id, from, to: lines.length });
    }
    this.rects = rects;
    return lines;
  }

  /** Row rects from the last paint; read by tests to place mouse events. */
  regionRects(): readonly RegionRect[] {
    return this.rects;
  }

}
