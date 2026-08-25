/** @jsxImportSource @opentui/solid */
/**
 * TUI2 which-key — searchable command palette (opencode-style `mod+k`).
 *
 * Replaces the v1 `WhichKeyComponent` (a pi-tui `Container`) with an opentui
 * SolidJS view. The picker is searchable by label / keys, navigates with
 * ↑/↓, executes on Enter, closes on Esc / `q`. Two modes:
 *  - `focusable: true` (default): a modal mounted via the editor
 *    replacement. Search + execute are available.
 *  - `focusable: false`: a transient overlay while the leader key is
 *    armed. The editor keeps focus; the host removes the overlay when the
 *    chord fires or times out. In this mode the picker is not focused and
 *    consumes no key events itself.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { LEADER_CHORDS, type LeaderAction } from '../../keybindings'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type ShortcutAction =
  | 'exit'
  | 'interrupt'
  | 'external-editor'
  | 'toggle-tool-output'
  | 'steer'
  | 'detach'
  | 'toggle-todo'
  | 'plan-mode'
  | 'undo'
  | 'escape'
  | 'which-key'
  | 'navigate'
  | 'agent-pane'
  | 'review'
  | 'newline'

export type WhichKeyAction = LeaderAction | ShortcutAction

export interface WhichKeyProps {
  readonly onClose?: () => void
  readonly onSelect?: (action: WhichKeyAction) => void
  readonly focusable?: boolean
}

interface CommandEntry {
  readonly keys: string
  readonly label: string
  readonly action: WhichKeyAction
  readonly section: 'leader' | 'shortcuts'
}

function leaderActionLabelKey(action: LeaderAction): string {
  return `tui.dialogs.whichKey.actions.${action.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`
}

function shortcutLabelKey(action: ShortcutAction): string {
  switch (action) {
    case 'exit':
      return 'tui.dialogs.whichKey.shortcuts.ctrlD'
    case 'interrupt':
      return 'tui.dialogs.whichKey.shortcuts.ctrlC'
    case 'external-editor':
      return 'tui.dialogs.whichKey.shortcuts.ctrlG'
    case 'toggle-tool-output':
      return 'tui.dialogs.whichKey.shortcuts.ctrlO'
    case 'steer':
      return 'tui.dialogs.whichKey.shortcuts.ctrlS'
    case 'detach':
      return 'tui.dialogs.whichKey.shortcuts.ctrlB'
    case 'toggle-todo':
      return 'tui.dialogs.whichKey.shortcuts.ctrlT'
    case 'plan-mode':
      return 'tui.dialogs.whichKey.shortcuts.shiftTab'
    case 'undo':
      return 'tui.dialogs.whichKey.shortcuts.undo'
    case 'escape':
      return 'tui.dialogs.whichKey.shortcuts.escape'
    case 'which-key':
      return 'tui.dialogs.whichKey.shortcuts.whichKey'
    case 'navigate':
      return 'tui.dialogs.whichKey.shortcuts.transcriptNav'
    case 'agent-pane':
      return 'tui.dialogs.whichKey.shortcuts.agentPane'
    case 'review':
      return 'tui.dialogs.whichKey.shortcuts.review'
    case 'newline':
      return 'tui.dialogs.whichKey.shortcuts.newLine'
  }
}

const ALL_ENTRIES: readonly CommandEntry[] = [
  ...LEADER_CHORDS.map(({ key, action }) => ({
    keys: `Ctrl-X ${key}`,
    label: t(leaderActionLabelKey(action)),
    action,
    section: 'leader' as const,
  })),
  ...(
    [
      ['Ctrl-D', 'exit'],
      ['Ctrl-C', 'interrupt'],
      ['Ctrl-G', 'external-editor'],
      ['Ctrl-O', 'toggle-tool-output'],
      ['Ctrl-S', 'steer'],
      ['Ctrl-B', 'detach'],
      ['Ctrl-T', 'toggle-todo'],
      ['Shift-Tab', 'plan-mode'],
      ['Ctrl--', 'undo'],
      ['Esc', 'escape'],
      ['Ctrl-Alt-K', 'which-key'],
      ['Ctrl-X V', 'navigate'],
      ['Ctrl-X P', 'agent-pane'],
      ['Ctrl-X D', 'review'],
      ['Shift-Enter / Ctrl-J', 'newline'],
    ] as const
  ).map(([keys, action]) => ({
    keys,
    label: t(shortcutLabelKey(action)),
    action,
    section: 'shortcuts' as const,
  })),
]

export const WhichKey: Component<WhichKeyProps> = (props) => {
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const filtered = createMemo<readonly CommandEntry[]>(() => {
    const q = query().trim().toLowerCase()
    if (q.length === 0) return ALL_ENTRIES
    return ALL_ENTRIES.filter(
      (entry) =>
        entry.label.toLowerCase().includes(q) || entry.keys.toLowerCase().includes(q),
    )
  })

  function move(delta: number): void {
    const entries = filtered()
    if (entries.length === 0) return
    setSelectedIndex((i) => (i + delta + entries.length) % entries.length)
  }

  function applyKey(event: KeyEvent): void {
    if (props.focusable === false) return
    if (event.repeated === true) return
    if (event.name === 'escape' || event.name === 'q' || event.name === 'Q') {
      event.stopPropagation()
      props.onClose?.()
      return
    }
    if (event.name === 'return' || event.name === 'enter') {
      const entry = filtered()[selectedIndex()]
      if (entry !== undefined) {
        event.stopPropagation()
        props.onSelect?.(entry.action)
      }
      props.onClose?.()
      return
    }
    if (event.name === 'backspace') {
      setQuery((q) => q.slice(0, -1))
      setSelectedIndex(0)
      return
    }
    if (event.name === 'up') {
      move(-1)
      return
    }
    if (event.name === 'down') {
      move(1)
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      setQuery((q) => q + ch)
      setSelectedIndex(0)
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
  const warningFg = (): ColorInput => currentTheme.color('warning')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.whichKey.title')}`}</Text>
        <Show when={props.focusable !== false}>
          <Text fg={textMutedFg()}>{` ${t('tui.dialogs.whichKey.cancelHint')}`}</Text>
        </Show>
      </Box>
      {/* Search line */}
      <Show when={props.focusable !== false}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={textFg()}>{`  ${t('tui.dialogs.whichKey.searchLabel')}${query()}`}</Text>
        </Box>
      </Show>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Empty */}
      <Show
        when={filtered().length > 0}
        fallback={
          <Box>
            <Text fg={textMutedFg()}>{`  ${t('tui.dialogs.whichKey.noMatches')}`}</Text>
          </Box>
        }
      >
        <For each={filtered()}>
          {(entry, i) => {
            const selected = (): boolean => i() === selectedIndex()
            return (
              <Box flexDirection="row">
                <Show
                  when={selected()}
                  fallback={
                    <>
                      <Text>{'    '}</Text>
                      <Text fg={warningFg()}>{entry.keys.padEnd(14)}</Text>
                      <Text>{'  '}</Text>
                      <Text fg={textDimFg()}>{entry.label}</Text>
                    </>
                  }
                >
                  <Text>{'    '}</Text>
                  <Text fg={warningFg()}>{entry.keys.padEnd(14)}</Text>
                  <Text>{'  '}</Text>
                  <Text fg={textFg()}>{entry.label}</Text>
                </Show>
              </Box>
            )
          }}
        </For>
      </Show>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}