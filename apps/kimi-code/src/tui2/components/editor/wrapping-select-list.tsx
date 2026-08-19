/** @jsxImportSource @opentui/solid */
/**
 * TUI2 wrapping select list — searchable picker with wrapped descriptions.
 *
 * Replaces the v1 `WrappingSelectList` (a pi-tui `SelectList` subclass with
 * a 2-line description renderer) with an opentui SolidJS view. The picker
 * is self-contained: cursor / query signals, fuzzy search through
 * `fuzzyFilter`, and a primary / description layout. The description is
 * wrapped to up to 2 lines (anything past the second line is ellipsized).
 *
 * Keyboard: ↑/↓ / Tab / Shift+Tab navigate, Enter selects, printable
 * characters filter, Backspace deletes, Esc cancels.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { fuzzyFilter } from '@moonshot-ai/pi-tui'

import { t } from '#/i18n'

import { pageView } from '../../utils/paging'
import { getCurrentMark, SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'
const MAX_DESCRIPTION_LINES = 2
const DEFAULT_PAGE_SIZE = 8

export interface WrappingSelectItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface WrappingSelectListProps {
  readonly title: string
  readonly items: readonly WrappingSelectItem[]
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
  readonly pageSize?: number
  readonly width: number
}

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    current = word.length <= safeWidth ? word : `${word.slice(0, Math.max(1, safeWidth - 1))}${ELLIPSIS}`
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

export const WrappingSelectList: Component<WrappingSelectListProps> = (props) => {
  const [cursor, setCursor] = createSignal(0)
  const [query, setQuery] = createSignal('')

  const filtered = createMemo<readonly WrappingSelectItem[]>(() => {
    const q = query()
    if (q.length === 0) return props.items
    return fuzzyFilter(
      [...props.items],
      q,
      (item) => `${item.label} ${item.description ?? ''}`,
    )
  })

  const pageSize = (): number => props.pageSize ?? DEFAULT_PAGE_SIZE
  const page = createMemo(() => pageView(filtered().length, cursor(), pageSize()))
  const selectedIndex = createMemo(() => Math.min(cursor(), Math.max(0, filtered().length - 1)))
  const visible = createMemo(() => filtered().slice(page().start, page().end))

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setCursor((c) => Math.max(0, c - 1))
        return
      case 'down':
        setCursor((c) => Math.min(Math.max(0, filtered().length - 1), c + 1))
        return
      case 'pageup':
        setCursor((c) => Math.max(0, c - pageSize()))
        return
      case 'pagedown':
        setCursor((c) => Math.min(Math.max(0, filtered().length - 1), c + pageSize()))
        return
      case 'return':
      case 'enter':
        event.stopPropagation()
        {
          const item = filtered()[selectedIndex()]
          if (item !== undefined) props.onSelect(item.value)
        }
        return
      case 'tab':
        setCursor((c) => (c + 1) % Math.max(1, filtered().length))
        return
      case 'backtab':
        setCursor((c) => (c - 1 + Math.max(1, filtered().length)) % Math.max(1, filtered().length))
        return
      case 'backspace':
        setQuery((q) => q.slice(0, -1))
        setCursor(0)
        return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      setQuery((q) => q + ch)
      setCursor(0)
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const successFg = (): ColorInput => currentTheme.color('success')

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${props.title}`}</Text>
      </Box>
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.editor.selectHint')}`}</Text>
      </Box>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Show when={query().length > 0}>
        <Box flexDirection="row">
          <Text fg={titleFg()}>{` ${t('tui.dialogs.modelSelector.searchLabel')}`}</Text>
          <Text fg={textFg()}>{query()}</Text>
        </Box>
      </Show>
      <Show
        when={visible().length > 0}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{`   ${t('tui.dialogs.modelSelector.noMatches')}`}</Text>
          </Box>
        }
      >
        <For each={visible()}>
          {(item, i) => {
            const realIndex = (): number => page().start + i()
            const selected = (): boolean => realIndex() === selectedIndex()
            const primary = (): string => item.label
            const descLines = (): readonly string[] =>
              item.description !== undefined && item.description.length > 0
                ? wrapPlain(item.description, Math.max(8, props.width - 6)).slice(
                    0,
                    MAX_DESCRIPTION_LINES,
                  )
                : []
            return (
              <>
                <Box flexDirection="row">
                  <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                  <Text
                    fg={selected() ? titleFg() : textFg()}
                    attributes={selected() ? titleAttrs() : undefined}
                  >
                    {primary()}
                  </Text>
                  <Show when={realIndex() === filtered().findIndex((it) => it.value === props.items[realIndex()]?.value) && false}>
                    <Text fg={successFg()}>{` ${getCurrentMark()}`}</Text>
                  </Show>
                </Box>
                <For each={descLines()}>
                  {(line) => (
                    <Box>
                      <Text>{'    '}</Text>
                      <Text fg={textDimFg()}>{line}</Text>
                    </Box>
                  )}
                </For>
              </>
            )
          }}
        </For>
      </Show>
      <Box>
        <Text>{''}</Text>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}