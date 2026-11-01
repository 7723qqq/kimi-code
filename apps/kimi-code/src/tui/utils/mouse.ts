/**
 * Mouse routing shared by every dialog and panel.
 *
 * The alternate-screen renderer captures the mouse, so a component that does
 * not answer mouse events is dead to the pointer. Rather than each panel
 * re-deriving the same three rules — the focus hand-off, the wheel direction
 * and the settling window — this module owns them once:
 *
 * - {@link DialogMouse} is the stateful facade a panel holds: it answers the
 *   hand-off, converts a notch into a direction, and says whether a click
 *   arrived too soon after the panel appeared to be deliberate.
 * - {@link ListMouseRouter} is the standard cursor interaction built on it:
 *   the row under the pointer highlights, the wheel turns the page, a click
 *   picks.
 * - {@link ScrollMouseRouter} is the wheel-only variant for a panel that
 *   scrolls its own body.
 * - {@link mouseDispatch} wraps whatever a panel answered into the dispatch
 *   shape a container expects.
 *
 * A panel with its own hit model (tabs, submit actions, multi-select rows)
 * keeps its branches here in the component, but takes the three rules above
 * from {@link DialogMouse} instead of restating them.
 */

import type {
  Component,
  Input,
  TuiMouseDispatchResult,
  TuiMouseEvent,
  TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { isSettlingClick } from '#/tui/utils/terminal-focus';

import type { SearchableList } from './searchable-list';

/** A rectangle a pointer can land in, in the panel's own frame coordinates. */
export interface RowRegion {
  /** First rendered line of the row (inclusive). */
  readonly start: number;
  /** Last rendered line of the row (exclusive). */
  readonly end: number;
  /**
   * Columns the row occupies. A panel that lays a list out beside another
   * column (the task browser's list and detail panes) sets these so a click
   * in the other column does not land on a row.
   */
  readonly columnStart?: number;
  /** Column just past the row's last column (exclusive). */
  readonly columnEnd?: number;
}

/** One rendered row, in the dialog's own frame coordinates. */
export interface ListRowRegion extends RowRegion {
  /** Index of the row in the list's items. */
  readonly index: number;
}

/** The region under the pointer, if any. */
export function regionAt<T extends RowRegion>(
  regions: readonly T[],
  event: { readonly x: number; readonly y: number },
): T | undefined {
  return regions.find((region) => {
    if (event.y < region.start || event.y >= region.end) return false;
    if (region.columnStart !== undefined && event.x < region.columnStart) return false;
    if (region.columnEnd !== undefined && event.x >= region.columnEnd) return false;
    return true;
  });
}

/**
 * The three pointer rules every panel shares.
 *
 * Held by the panel for its lifetime so the settling window is measured from
 * the moment the panel appeared, not from the first event it happened to see.
 */
export class DialogMouse {
  private readonly shownAt: number;

  /**
   * @param isFocused Whether the panel currently holds the keyboard.
   * @param shownAt When the panel appeared; a click inside the settling
   *   window is ignored. Defaults to now.
   */
  constructor(
    private readonly isFocused: () => boolean = () => true,
    shownAt: number = Date.now(),
  ) {
    this.shownAt = shownAt;
  }

  /**
   * The answer for an event that arrives before the panel holds the keyboard.
   *
   * The first press only stops the event from reaching whatever is behind the
   * panel, and the first click hands the keyboard over; the next click acts.
   * Without this a panel that opened under the pointer would act on the very
   * click that opened it. Returns `undefined` once the panel is focused, so a
   * caller reads it as "this event is yours to interpret".
   */
  handoff(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.isFocused()) return undefined;
    if (event.type === 'press') return { handled: true };
    if (event.type === 'click') return { handled: true, focus: true };
    return undefined;
  }

  /** `-1` / `1` for a wheel notch, `0` for anything that is not a wheel turn. */
  wheel(event: TuiMouseEvent): -1 | 0 | 1 {
    if (event.type !== 'wheel' || event.wheelDelta === undefined) return 0;
    return event.wheelDelta < 0 ? -1 : 1;
  }

  /**
   * Whether this click lands too soon after the panel appeared to be a
   * deliberate answer. Navigation may still follow it; committing may not.
   */
  settling(event: TuiMouseEvent): boolean {
    return event.type === 'click' && isSettlingClick(this.shownAt);
  }
}

/**
 * The cursor a list dialog exposes to the mouse: where it points and how it
 * turns pages. {@link searchableListCursor} adapts the shared list state
 * machine; a dialog with its own list implements this directly.
 */
export interface ListCursor<T> {
  /** The items the rows map to. */
  items(): readonly T[];
  /** The index the cursor points at. */
  selectedIndex(): number;
  /** How many pages the list has. */
  pageCount(): number;
  /** Move the cursor to an index. */
  moveTo(index: number): void;
  /** Turn one page. */
  page(direction: -1 | 1): void;
}

export interface ListMouseRouterOptions {
  /** When the panel appeared; a click inside the settling window is ignored. */
  readonly shownAt?: number;
  /** Whether the panel currently holds the keyboard focus. */
  readonly isFocused?: () => boolean;
}

/**
 * Adapts the shared list state machine to the cursor the router drives.
 *
 * The list is read through a getter because a dialog may rebuild it (a new
 * page of goals, a reloaded set of sessions) while the router stays mounted.
 */
export function searchableListCursor<T>(getList: () => SearchableList<T>): ListCursor<T> {
  return {
    items: () => getList().view().items,
    selectedIndex: () => getList().view().selectedIndex,
    pageCount: () => getList().view().page.pageCount,
    moveTo: (index) => {
      getList().moveTo(index);
    },
    page: (direction) => {
      const list = getList();
      if (direction < 0) list.pageUp();
      else list.pageDown();
    },
  };
}

export class ListMouseRouter<T> {
  private readonly mouse: DialogMouse;
  private regions: readonly ListRowRegion[] = [];

  constructor(
    private readonly cursor: ListCursor<T>,
    private readonly pick: (item: T) => void,
    options: ListMouseRouterOptions = {},
  ) {
    this.mouse = new DialogMouse(options.isFocused, options.shownAt);
  }

  /** The rows the dialog drew, in the dialog's own frame coordinates. */
  setRegions(regions: readonly ListRowRegion[]): void {
    this.regions = regions;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const handoff = this.mouse.handoff(event);
    if (handoff !== undefined) return handoff;

    if (event.type === 'wheel') {
      const direction = this.mouse.wheel(event);
      if (direction === 0 || this.cursor.pageCount() <= 1) return { handled: true };
      const before = this.cursor.selectedIndex();
      this.cursor.page(direction);
      return { handled: true, render: this.cursor.selectedIndex() !== before };
    }

    if (event.type === 'move') {
      const index = this.rowIndexAt(event);
      if (index === undefined) return undefined;
      return { handled: true, render: this.moveTo(index) };
    }

    if (event.button !== 'left') return undefined;
    const index = this.rowIndexAt(event);
    if (index === undefined) return undefined;
    if (event.type === 'press') {
      return { handled: true, render: this.moveTo(index) };
    }
    if (event.type === 'click') {
      if (this.mouse.settling(event)) return { handled: true };
      this.moveTo(index);
      const item = this.cursor.items()[index];
      if (item !== undefined) this.pick(item);
    }
    return { handled: true };
  }

  private rowIndexAt(event: TuiMouseEvent): number | undefined {
    return regionAt(this.regions, event)?.index;
  }

  private moveTo(index: number): boolean {
    const changed = this.cursor.selectedIndex() !== index;
    this.cursor.moveTo(index);
    return changed;
  }
}

/**
 * A wheel gesture: the direction, and the raw notch count the terminal sent.
 * Returning `false` means the view did not move, which suppresses the repaint.
 */
export type ScrollStep = (direction: -1 | 1, delta: number) => boolean;

/**
 * Wheel-only routing for a panel that scrolls its own content and has
 * nothing to pick: the wheel moves the view, every other pointer event is
 * left to the renderer.
 *
 * The callback gets both the direction and the raw delta, so a panel that
 * scrolls a fixed number of rows per notch and one that scrolls as far as the
 * wheel turned read the same gesture instead of each decoding it. Its answer
 * is the repaint decision: a notch against the end of the content scrolls
 * nothing and asks for no repaint.
 *
 * `alwaysConsume` is for a panel that owns the wheel outright — the one whose
 * content sits over a transcript, where letting the notch through would scroll
 * the conversation out from under the pointer.
 */
export class ScrollMouseRouter {
  constructor(
    private readonly scroll: ScrollStep,
    private readonly alwaysConsume = false,
  ) {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || event.wheelDelta === undefined) return undefined;
    const delta = event.wheelDelta;
    // A notch that carries no movement is not a gesture; leaving it unconsumed
    // lets whatever scrolls behind the panel take it.
    if (delta === 0) return undefined;
    const moved = this.scroll(delta < 0 ? -1 : 1, delta);
    if (this.alwaysConsume) return { handled: true };
    return { handled: true, render: moved };
  }
}

export interface InputFrame {
  /** Row the input line was rendered on, in the dialog's own frame. */
  readonly row: number;
  /** Column the input's own frame starts at. */
  readonly column: number;
}

/**
 * Where the pointer landed on an input line, if it did.
 *
 * A form draws its `Input` inside a box, so the input's own frame starts after
 * the border and the padding. `Input.handleMouse` answers only a press on its
 * own row, so the dialog shifts the event into that frame here instead of
 * repeating the same arithmetic in every form.
 */
export function inputPressAt(
  input: Input,
  event: TuiMouseEvent,
  frame: InputFrame,
): TuiMouseEventResult | undefined {
  if (event.type !== 'press' && event.type !== 'click') return undefined;
  if (event.y !== frame.row || event.x < frame.column) return undefined;
  // `Input.handleMouse` answers presses only. A click is the same point, and
  // placing the caret twice is harmless, so both arrive as a press.
  return input.handleMouse({ ...event, type: 'press', x: event.x - frame.column, y: 0 });
}

/**
 * Wrap a panel's mouse answer into the dispatch shape a container expects:
 * the target metadata says which component took the event and how its
 * coordinates map back to the screen.
 */
export function mouseDispatch(
  component: Component,
  event: TuiMouseEvent,
  result: TuiMouseEventResult | undefined,
): TuiMouseDispatchResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    handled: true,
    target: {
      component,
      originX: event.screenX - event.x,
      originY: event.screenY - event.y,
      width: event.width,
      height: event.height,
    },
  };
}
