/**
 * TUI2 searchable-list state machine — cursor + fuzzy search + paging,
 * shared by list pickers (ChoicePicker, ModelSelector, …).
 *
 * Mirrors the *behavior* of `tui/utils/searchable-list.ts` (v1's pi-tui
 * class) as a SolidJS hook: the picker owns presentation and the keys that
 * carry component-specific meaning — Enter (submit), Esc (cancel), ←/→
 * (paging in one picker, a thinking toggle in another). This hook owns the
 * state and the keys that behave identically everywhere: ↑/↓, PgUp/PgDn,
 * and search editing (printable chars, backspace).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { createMemo, createSignal } from 'solid-js';
import type { KeyEvent } from '@opentui/core';

import { fuzzyFilter } from './fuzzy';
import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

export interface SearchableListOptions<T> {
  /** Reactive item set; the hook re-filters when it changes. */
  readonly items: () => readonly T[];
  /** Text a list item is fuzzy-matched against. */
  readonly toSearchText: (item: T) => string;
  /** Items per page; defaults to 8. */
  readonly pageSize?: number;
  /** Initial cursor position (clamped to >= 0). */
  readonly initialIndex?: number;
  /** When false, typed characters are ignored. Defaults to false. */
  readonly searchable?: boolean;
}

export interface SearchableList<T> {
  readonly cursor: () => number;
  readonly setCursor: (value: number | ((current: number) => number)) => void;
  readonly query: () => string;
  readonly setQuery: (value: string | ((current: string) => string)) => void;
  /** Items after the active query filter. */
  readonly filtered: () => readonly T[];
  /** Page math for the current cursor over {@link filtered}. */
  readonly page: () => PageView;
  /** Cursor clamped into the current filtered range. */
  readonly selectedIndex: () => number;
  /** The filtered slice for the current page. */
  readonly visible: () => readonly T[];
  /** The item under the cursor, clamped into the filtered range. */
  readonly selected: () => T | undefined;
  /**
   * Handle the keys shared by every picker: ↑/↓, PgUp/PgDn, and search
   * editing (printable chars append to the query, backspace removes).
   * Returns true when the key was consumed. Component-specific keys
   * (Enter / Esc / ←→ / Space / Alt+S) stay in the picker.
   */
  readonly handleNavigationKey: (event: KeyEvent) => boolean;
}

export function createSearchableList<T>(options: SearchableListOptions<T>): SearchableList<T> {
  const pageSize = (): number => options.pageSize ?? DEFAULT_PAGE_SIZE;
  const searchable = (): boolean => options.searchable ?? false;
  const [cursor, setCursor] = createSignal(Math.max(options.initialIndex ?? 0, 0));
  const [query, setQuery] = createSignal('');

  const filtered = createMemo<readonly T[]>(() => {
    const items = options.items();
    const q = query();
    if (q.length === 0) return items;
    return fuzzyFilter([...items], q, options.toSearchText);
  });
  const page = createMemo(() => pageView(filtered().length, cursor(), pageSize()));
  const selectedIndex = createMemo(() => Math.min(cursor(), Math.max(0, filtered().length - 1)));
  const visible = createMemo(() => filtered().slice(page().start, page().end));
  const selected = createMemo(() => filtered()[selectedIndex()]);

  function handleNavigationKey(event: KeyEvent): boolean {
    switch (event.name) {
      case 'up':
        setCursor((c) => Math.max(0, c - 1));
        return true;
      case 'down': {
        const len = filtered().length;
        setCursor((c) => Math.min(Math.max(0, len - 1), c + 1));
        return true;
      }
      case 'pageup':
        setCursor((c) => Math.max(0, c - pageSize()));
        return true;
      case 'pagedown': {
        const len = filtered().length;
        setCursor((c) => Math.min(Math.max(0, len - 1), c + pageSize()));
        return true;
      }
      case 'backspace':
        if (searchable() && query().length > 0) {
          setQuery((q) => q.slice(0, -1));
          setCursor(0);
          return true;
        }
        return false;
    }
    if (searchable()) {
      const raw = event.sequence !== undefined && event.sequence.length > 0 ? event.sequence : event.name;
      const ch = printableChar(raw);
      if (isPrintableChar(ch)) {
        setQuery((q) => q + ch);
        setCursor(0);
        return true;
      }
    }
    return false;
  }

  return {
    cursor,
    setCursor,
    query,
    setQuery,
    filtered,
    page,
    selectedIndex,
    visible,
    selected,
    handleNavigationKey,
  };
}
