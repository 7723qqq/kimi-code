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
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { fuzzyFilter } from '../../utils/fuzzy'

import { t } from '#/i18n'

import { pageView } from '../../utils/paging'
import { isPrintableChar, printableChar } from '../../utils/printable-key'
import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme, type ColorToken } from '../../theme'

import { Box } from '../common/box'
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
  const initialCursor = (): number => {
    const idx = props.options.findIndex((o) => o.value === props.currentValue)
    return Math.max(idx, 0)
  }
  const [cursor, setCursor] = createSignal(initialCursor())
  const [query, setQuery] = createSignal('')

  const filtered = createMemo<readonly ChoiceOption[]>(() => {
    const opts = props.options
    const q = query()
    if (q.length === 0) return opts
    return fuzzyFilter([...opts], q, (o) => `${o.label} ${o.description ?? ''}`)
  })
  const pageSize = (): number => props.pageSize ?? DEFAULT_PAGE_SIZE
  const page = createMemo(() => pageView(filtered().length, cursor(), pageSize()))
  const selectedIndex = createMemo(() => Math.min(cursor(), Math.max(0, filtered().length - 1)))
  const visible = createMemo(() => filtered().slice(page().start, page().end))
  const isSearchable = (): boolean => props.searchable === true

  function commit(): void {
    const opt = filtered()[selectedIndex()]
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
        setCursor((c) => Math.max(0, c - pageSize()))
        return
      case 'right': {
        const len = filtered().length
        setCursor((c) => Math.min(Math.max(0, len - 1), c + pageSize()))
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
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down': {
        const len = filtered().length
        setCursor((c) => Math.min(Math.max(0, len - 1), c + 1))
        return
      }
      case 'pageup':
        setCursor((c) => Math.max(0, c - pageSize()))
        return
      case 'pagedown': {
        const len = filtered().length
        setCursor((c) => Math.min(Math.max(0, len - 1), c + pageSize()))
        return
      }
      case 'backspace':
        if (isSearchable() && query().length > 0) {
          setQuery((q) => q.slice(0, -1))
          setCursor(0)
        }
        return
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
    // Search printable: append to query, reset cursor.
    if (isSearchable()) {
      const raw = event.sequence !== undefined && event.sequence.length > 0 ? event.sequence : event.name
      const ch = printableChar(raw)
      if (isPrintableChar(ch)) {
        setQuery((q) => q + ch)
        setCursor(0)
      }
    }
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
              <>
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
              </>
            )
          }}
        </For>
      </Show>
      {/* Blank line above the footer */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Page indicator — only when paging */}
      <Show when={pageLabel().length > 0}>
        <Box>
          <Text fg={hintFg()}>{` ${pageLabel()}`}</Text>
        </Box>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}