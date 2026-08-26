/**
 * TUI2 searchable-list hook tests.
 *
 * The hook owns the state and keys shared by every list picker: cursor,
 * fuzzy query, paging, and ↑/↓ / PgUp/PgDn / search editing. Component
 * tests (choice-picker) cover the integration; these pin the state machine
 * itself.
 */

import { describe, expect, it } from 'vitest'
import type { KeyEvent } from '@opentui/core'

import { createSearchableList } from '@/tui2/utils/searchable-list'

const ITEMS = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
  { value: 'delta', label: 'Delta' },
  { value: 'epsilon', label: 'Epsilon' },
  { value: 'zeta', label: 'Zeta' },
  { value: 'eta', label: 'Eta' },
  { value: 'theta', label: 'Theta' },
  { value: 'iota', label: 'Iota' },
  { value: 'kappa', label: 'Kappa' },
]

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: '',
    number: false,
    raw: '',
    eventType: 'press',
    source: 'raw',
    stopPropagation: () => {},
    ...mods,
  } as KeyEvent
}

function make(options?: Partial<Parameters<typeof createSearchableList<{ value: string; label: string }>>[0]>) {
  return createSearchableList({
    items: () => ITEMS,
    toSearchText: (item) => item.label,
    ...options,
  })
}

describe('createSearchableList', () => {
  it('starts on the initial index with the full item set', () => {
    const list = make({ initialIndex: 2 })
    expect(list.cursor()).toBe(2)
    expect(list.filtered()).toHaveLength(ITEMS.length)
    expect(list.selected()?.value).toBe('gamma')
  })

  it('filters by query and resets the cursor', () => {
    const list = make()
    list.setQuery('be')
    expect(list.filtered().map((i) => i.value)).toEqual(['beta'])
    expect(list.selected()?.value).toBe('beta')
  })

  it('pages the visible slice and clamps the cursor', () => {
    const list = make({ pageSize: 4 })
    expect(list.visible()).toHaveLength(4)
    expect(list.page().pageCount).toBe(3)
    list.setCursor(5)
    expect(list.page().page).toBe(1)
    expect(list.visible().map((i) => i.value)).toEqual(['epsilon', 'zeta', 'eta', 'theta'])
  })

  it('↑/↓ move the cursor within bounds', () => {
    const list = make()
    expect(list.handleNavigationKey(key('down'))).toBe(true)
    expect(list.cursor()).toBe(1)
    list.setCursor(0)
    expect(list.handleNavigationKey(key('up'))).toBe(true)
    expect(list.cursor()).toBe(0)
  })

  it('PgUp/PgDn page by the page size', () => {
    const list = make({ pageSize: 4 })
    expect(list.handleNavigationKey(key('pagedown'))).toBe(true)
    expect(list.cursor()).toBe(4)
    expect(list.handleNavigationKey(key('pageup'))).toBe(true)
    expect(list.cursor()).toBe(0)
  })

  it('searchable mode appends printable chars and backspace removes them', () => {
    const list = make({ searchable: true })
    expect(list.handleNavigationKey(key('b'))).toBe(true)
    expect(list.query()).toBe('b')
    expect(list.handleNavigationKey(key('e'))).toBe(true)
    expect(list.query()).toBe('be')
    expect(list.handleNavigationKey(key('backspace'))).toBe(true)
    expect(list.query()).toBe('b')
  })

  it('non-searchable mode ignores printable chars and backspace', () => {
    const list = make({ searchable: false })
    expect(list.handleNavigationKey(key('b'))).toBe(false)
    expect(list.query()).toBe('')
    expect(list.handleNavigationKey(key('backspace'))).toBe(false)
  })

  it('leaves component-specific keys unconsumed', () => {
    const list = make()
    expect(list.handleNavigationKey(key('return'))).toBe(false)
    expect(list.handleNavigationKey(key('escape'))).toBe(false)
    expect(list.handleNavigationKey(key('left'))).toBe(false)
  })
})
