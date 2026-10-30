/**
 * Mouse routing shared by the dialogs.
 *
 * The alternate-screen renderer captures the mouse, so a dialog that does not
 * answer mouse events is dead to the pointer. List dialogs answer the same
 * way: the row under the pointer is highlighted, the wheel turns the page,
 * and a click on a row picks it. A panel that only scrolls its own content
 * (the help panel) needs the wheel alone.
 *
 * The dialog records the rectangles of its rows while rendering and hands
 * them over here, so the routing lives in one place instead of being copied
 * into every dialog.
 */

import type {
  Component,
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
  private readonly shownAt: number;
  private readonly isFocused: () => boolean;
  private regions: readonly ListRowRegion[] = [];

  constructor(
    private readonly cursor: ListCursor<T>,
    private readonly pick: (item: T) => void,
    options: ListMouseRouterOptions = {},
  ) {
    this.shownAt = options.shownAt ?? Date.now();
    this.isFocused = options.isFocused ?? (() => true);
  }

  /** The rows the dialog drew, in the dialog's own frame coordinates. */
  setRegions(regions: readonly ListRowRegion[]): void {
    this.regions = regions;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.isFocused()) {
      // The first click only hands the keyboard to the panel; the next one
      // picks. Without this a panel that opened under the pointer would act on
      // the very click that opened it.
      if (event.type === 'press') return { handled: true };
      if (event.type === 'click') return { handled: true, focus: true };
      return undefined;
    }
    if (event.type === 'wheel') {
      if (this.cursor.pageCount() <= 1 || event.wheelDelta === undefined) return { handled: true };
      const before = this.cursor.selectedIndex();
      this.cursor.page(event.wheelDelta < 0 ? -1 : 1);
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
      if (isSettlingClick(this.shownAt)) return { handled: true };
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
 * Wheel-only routing for a panel that scrolls its own content and has
 * nothing to pick: the wheel moves the view, every other pointer event is
 * left to the renderer.
 */
export class ScrollMouseRouter {
  constructor(private readonly scroll: (direction: -1 | 1) => boolean) {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || event.wheelDelta === undefined) return undefined;
    return { handled: true, render: this.scroll(event.wheelDelta < 0 ? -1 : 1) };
  }
}

/**
 * Wrap a list dialog's mouse answer into the dispatch shape a container
 * expects: the target metadata says which component took the event and how
 * its coordinates map back to the screen.
 */
export function listMouseDispatch(
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
