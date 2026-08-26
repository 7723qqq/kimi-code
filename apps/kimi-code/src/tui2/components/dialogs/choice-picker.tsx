/** @jsxImportSource @opentui/solid */
/**
 * ChoicePicker — modal single-select list (opentui + SolidJS edition).
 *
 * Replaces the pi-tui `ChoicePickerComponent` in
 * `tui/components/dialogs/choice-picker.ts` with an opentui SolidJS view.
 *
 * Visual contract (mirrors DESIGN.md §3, §7):
 *   ─ primary border, top + bottom
 *   ` <title>` (+ `(type to search)` suffix for searchable lists)
 *   ` <hint>` in textMuted
 *   <notice> (optional, success / warning tone)
 *   <blank>
 *   ` Search: <query>` (only when a query is active)
 *   `  ❯ <label> ← current` (or `   <label>`)
 *   `    <description>` (only when present, wrapped)
 *   <blank>
 *   ` <page / total>` (only when paging)
 *   ─ primary border
 *
 * Keyboard (also follows DESIGN.md §6):
 *   ↑↓  move                PgUp / PgDn  page
 *   ←→  page (no horizontal thinking toggle here)
 *   ⏎   select              Space  select (only when not searchable)
 *   Esc  two-stage: clear query first, then onCancel
 *   Alt+S  onSessionOnlySelect (when provided)
 *
 * State is owned by the component via signals (cursor, query); the host
 * mounts the picker, focuses it, and routes keyboard input via opentui's
 * `useKeyboard` (registered here). The picker fires `onSelect` /
 * `onSessionOnlySelect` / `onCancel` and the host tears it down. While
 * mounted, the picker is the sole keyboard consumer; the host disables
 * the editor / leader chords for the picker lifetime.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme, type ColorToken } from '../../theme'
import { createSearchableList } from '../../utils/searchable-list'

import { Box } from '../common/box'
import { Clickable } from '../common/clickable'
import { Text } from '../common/text'

export interface ChoiceOption {
  /** Value passed to onSelect. */
  readonly value: string
  /** Display text shown in the list. */
  readonly label: string
  /** Optional semantic tone for labels that need stronger visual treatment. */
  readonly tone?: 'danger'
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined
  /** Color token applied to the description while this option is selected. */
  readonly descriptionTone?: ColorToken
}

export interface ChoicePickerProps {
  readonly title: string
  readonly hint?: string
  readonly notice?: string
  /** Color tone for the notice line. Defaults to 'success'. */
  readonly noticeTone?: 'success' | 'warning'
  readonly options: readonly ChoiceOption[]
  readonly currentValue?: string
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number
  readonly onSelect: (value: string) => void
  /** When provided, Alt+S invokes this with the selected value instead of
   * onSelect — used to apply the choice to the current session only. */
  readonly onSessionOnlySelect?: (value: string) => void
  readonly onCancel: () => void
}

const DEFAULT_PAGE_SIZE = 8

export const ChoicePicker: Component<ChoicePickerProps> = (props) => {
  const list = createSearchableList<ChoiceOption>({
    items: () => props.options,
    toSearchText: (o) => `${o.label} ${o.description ?? ''}`,
    pageSize: props.pageSize,
    initialIndex: Math.max(
      props.options.findIndex((o) => o.value === props.currentValue),
      0,
    ),
    searchable: props.searchable,
  })
  const setCursor = list.setCursor
  const query = list.query
  const setQuery = list.setQuery
  const filtered = list.filtered
  const page = list.page
  const selectedIndex = list.selectedIndex
  const visible = list.visible
  const isSearchable = (): boolean => props.searchable === true

  function commit(): void {
    const opt = list.selected()
    if (opt !== undefined) props.onSelect(opt.value)
  }

  function applyKey(event: KeyEvent): void {
    switch (event.name) {
      case 'escape':
        if (query().length > 0) {
          setQuery('')
          setCursor(0)
          return
        }
        event.stopPropagation()
        props.onCancel()
        return
      case 'left':
        setCursor((c) => Math.max(0, c - (props.pageSize ?? DEFAULT_PAGE_SIZE)))
        return
      case 'right': {
        const len = filtered().length
        setCursor((c) => Math.min(Math.max(0, len - 1), c + (props.pageSize ?? DEFAULT_PAGE_SIZE)))
        return
      }
      case 'return':
      case 'enter':
        event.stopPropagation()
        commit()
        return
      case 'space':
        if (!isSearchable()) {
          event.stopPropagation()
          commit()
          return
        }
        // fall through: treat space as a search query character
        break
    }
    // Alt+S session-only select.
    if (
      event.option &&
      (event.name === 's' || event.name === 'S') &&
      props.onSessionOnlySelect !== undefined
    ) {
      const opt = filtered()[selectedIndex()]
      if (opt !== undefined) {
        event.stopPropagation()
        props.onSessionOnlySelect(opt.value)
      }
      return
    }
    // Shared navigation keys: ↑/↓, PgUp/PgDn, search editing.
    list.handleNavigationKey(event)
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const hintText = (): string => props.hint ?? t('tui.dialogs.choicePicker.navHint')
  const titleSuffix = (): string =>
    isSearchable() && query().length === 0
      ? `  (${t('tui.dialogs.choicePicker.searchHint')})`
      : ''
  const noticeLines = (): readonly string[] => {
    const notice = props.notice
    if (notice === undefined) return []
    return notice.split(/\r?\n/)
  }
  const noticeFg = (): ColorInput =>
    props.noticeTone === 'warning' ? currentTheme.color('warning') : currentTheme.color('success')
  const pageLabel = (): string => {
    const p = page()
    if (p.pageCount <= 1) return ''
    return t('tui.dialogs.choicePicker.page', { page: p.page + 1, pageCount: p.pageCount })
  }

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const successFg = (): ColorInput => currentTheme.color('success')
  const errorFg = (): ColorInput => currentTheme.color('error')

  function labelFg(opt: ChoiceOption, selected: boolean): ColorInput {
    if (opt.tone === 'danger') return errorFg()
    return selected ? titleFg() : textDimFg()
  }
  function labelAttrs(opt: ChoiceOption, selected: boolean): number | undefined {
    if (opt.tone === 'danger') return selected ? currentTheme.attributes('bold') : undefined
    return selected ? currentTheme.attributes('bold') : undefined
  }
  function descriptionFg(opt: ChoiceOption, selected: boolean): ColorInput {
    return selected && opt.descriptionTone !== undefined
      ? currentTheme.color(opt.descriptionTone)
      : currentTheme.color('textMuted')
  }

  return (
    <Box flexDirection="column">
      {/* Top border — single full-width line, primary */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title (+ "(type to search)" suffix) */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>
          {` ${props.title}`}
        </Text>
        <Show when={titleSuffix().length > 0}>
          <Text fg={hintFg()}>{titleSuffix()}</Text>
        </Show>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${hintText()}`}</Text>
      </Box>
      {/* Optional notice */}
      <Show when={noticeLines().length > 0}>
        <For each={noticeLines()}>
          {(line) => (
            <Box>
              <Text fg={noticeFg()}>{` ${line}`}</Text>
            </Box>
          )}
        </For>
      </Show>
      {/* Blank line between header and body */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Search line — only when a query is active */}
      <Show when={isSearchable() && query().length > 0}>
        <Box flexDirection="row">
          <Text fg={titleFg()}>{` Search: `}</Text>
          <Text fg={textFg()}>{query()}</Text>
        </Box>
      </Show>
      {/* List body */}
      <Show
        when={visible().length > 0}
        fallback={
          <Box>
            <Text fg={hintFg()}>{`   ${t('tui.dialogs.choicePicker.noMatches')}`}</Text>
          </Box>
        }
      >
        <For each={visible()}>
          {(opt, i) => {
            const realIndex = (): number => page().start + i()
            const selected = (): boolean => realIndex() === selectedIndex()
            const isCurrent = (): boolean => opt.value === props.currentValue
            const pointer = (): string => (selected() ? SELECT_POINTER : ' ')
            return (
              <Clickable
                onClick={() => props.onSelect(opt.value)}
                onHover={() => setCursor(realIndex())}
              >
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${pointer()} `}</Text>
                    <Text fg={labelFg(opt, selected())} attributes={labelAttrs(opt, selected())}>
                      {opt.label}
                    </Text>
                    <Show when={isCurrent()}>
                      <Text fg={successFg()}>{` ${getCurrentMark()}`}</Text>
                    </Show>
                  </Box>
                  <Show when={opt.description !== undefined && opt.description.length > 0}>
                    <Box>
                      <Text fg={descriptionFg(opt, selected())} wrapMode="word">
                        {`    ${opt.description}`}
                      </Text>
                    </Box>
                  </Show>
                </Box>
              </Clickable>
            )
          }}
        </For>
      </Show>
      {/* Blank line above the footer */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Page indicator — only when paging; a non-query "N more" hint when
          the list overflows without paging (model-selector parity). */}
      <Show when={pageLabel().length > 0}>
        <Box>
          <Text fg={hintFg()}>{` ${pageLabel()}`}</Text>
        </Box>
      </Show>
      <Show when={query().length === 0 && filtered().length > page().end}>
        <Box>
          <Text fg={hintFg()}>
            {` ${t('tui.dialogs.choicePicker.more', { count: filtered().length - page().end })}`}
          </Text>
        </Box>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}