/** @jsxImportSource @opentui/solid */
/**
 * TUI2 diff review pane — opencode-style file-change review panel shown
 * alongside the transcript.
 *
 * Replaces the v1 `DiffReviewPaneComponent` (a pi-tui `Container`) with
 * an opentui SolidJS view. Lists every file changed by the session's
 * tool calls (from the tool-call `display` data), with per-file add /
 * remove counts. ↑/↓ (or j/k) move the selection; Enter / → opens the
 * selected file's diff, ← / Esc returns to the list.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'
import { renderDiffLines } from '../media/diff-preview'

import { Box } from '../common/box'
import { Text } from '../common/text'

const MAX_DIFF_LINES = 200

export interface DiffReviewItem {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface DiffReviewPaneProps {
  readonly items: readonly DiffReviewItem[]
  readonly width: number
  readonly onOpenFile?: (path: string) => void
}

interface ViewMode {
  readonly mode: 'list' | 'detail'
}

export const DiffReviewPane: Component<DiffReviewPaneProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [viewMode, setViewMode] = createSignal<ViewMode['mode']>('list')
  const [scrollTop, setScrollTop] = createSignal(0)

  function selectedItem(): DiffReviewItem | undefined {
    return props.items[selectedIndex()]
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape') {
      if (viewMode() === 'detail') {
        event.stopPropagation()
        setViewMode('list')
      }
      return
    }
    if (viewMode() === 'detail') {
      if (event.name === 'left' || event.name === 'backspace') {
        event.stopPropagation()
        setViewMode('list')
        return
      }
      if (event.name === 'up') {
        setScrollTop((t) => Math.max(0, t - 1))
        return
      }
      if (event.name === 'down') {
        setScrollTop((t) => t + 1)
        return
      }
      return
    }
    if (event.name === 'return' || event.name === 'enter' || event.name === 'right') {
      if (selectedItem() !== undefined) {
        event.stopPropagation()
        setViewMode('detail')
        setScrollTop(0)
        props.onOpenFile?.(selectedItem()?.path ?? '')
      }
      return
    }
    if (event.name === 'up') {
      setSelectedIndex((i) =>
        Math.max(0, (i - 1 + props.items.length) % Math.max(1, props.items.length)),
      )
      return
    }
    if (event.name === 'down') {
      setSelectedIndex((i) => (i + 1) % Math.max(1, props.items.length))
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      if (ch === 'k' || ch === 'K') {
        setSelectedIndex((i) =>
          Math.max(0, (i - 1 + props.items.length) % Math.max(1, props.items.length)),
        )
        return
      }
      if (ch === 'j' || ch === 'J') {
        setSelectedIndex((i) => (i + 1) % Math.max(1, props.items.length))
      }
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('border')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const diffAddedFg = (): ColorInput => currentTheme.color('diffAdded')
  const _diffRemovedFg = (): ColorInput => currentTheme.color('diffRemoved')

  function diffStats(item: DiffReviewItem): string {
    const beforeSet = new Set(item.before ? item.before.split('\n') : [])
    const afterLines = item.after ? item.after.split('\n') : []
    const added = afterLines.filter((l) => !beforeSet.has(l)).length
    const removed = (item.before ? item.before.split('\n') : []).filter(
      (l) => !new Set(afterLines).has(l),
    ).length
    const parts: string[] = []
    if (added > 0) parts.push(`+${added}`)
    if (removed > 0) parts.push(`-${removed}`)
    return parts.join(' ')
  }

  function renderListView(): unknown {
    return (
      <For each={props.items}>
        {(item, i) => {
          const selected = (): boolean => i() === selectedIndex()
          const stats = diffStats(item)
          return (
            <Box flexDirection="row">
              <Text fg={selected() ? titleFg() : textMutedFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
              <Text fg={selected() ? titleFg() : textFg()}>{item.path}</Text>
              <Text>{' '}</Text>
              <Show
                when={stats.length > 0}
                fallback={<Text>{''}</Text>}
              >
                <Text>
                  <Show when={stats.includes('+')}>
                    <Text fg={diffAddedFg()}>{stats}</Text>
                  </Show>
                </Text>
              </Show>
            </Box>
          )
        }}
      </For>
    )
  }

  function renderDetailView(): unknown {
    const item = selectedItem()
    if (item === undefined) return null
    const diffLines = renderDiffLines(item.before, item.after, item.path, false, undefined, undefined, MAX_DIFF_LINES)
    return (
      <For each={diffLines}>
        {(line) => (
          <Box>
            <Text>{line}</Text>
          </Box>
        )}
      </For>
    )
  }
  void scrollTop

  return (
    <Box flexDirection="column">
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.diffReviewPane.title')}`}</Text>
      </Box>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      <Show
        when={props.items.length > 0}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{`  ${t('tui.panes.diffReviewPane.empty')}`}</Text>
          </Box>
        }
      >
        {viewMode() === 'detail' ? renderDetailView() : renderListView()}
      </Show>
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}