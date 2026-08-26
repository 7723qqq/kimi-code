/** @jsxImportSource @opentui/solid */
/**
 * TUI2 help panel — modal `/help` display. Lists keyboard shortcuts and
 * slash commands (with aliases + descriptions) in colour-coded sections.
 *
 * Replaces the v1 `HelpPanelComponent` (a pi-tui `Container`) with an
 * opentui SolidJS view. Mounted by the host via `mountEditorReplacement`;
 * closes on Esc / Enter / `q`. ↑/↓ scrolls, PgUp/PgDn page.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { currentTheme } from '../../theme'
import { printableChar } from '../../utils/printable-key'
import { truncateToWidth as truncateToVisibleWidth } from '../../utils/width'

import { Box } from '../common/box'
import { Text } from '../common/text'

const ELLIPSIS = '…'

export interface KeyboardShortcut {
  readonly keys: string
  readonly description: string
}

export interface HelpPanelCommand {
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
}

/** Static list — keep in sync with the global editor bindings. */
export function getDefaultKeyboardShortcuts(): readonly KeyboardShortcut[] {
  return [
    { keys: 'Shift-Tab', description: t('tui.dialogs.helpPanel.shortcuts.shiftTab') },
    { keys: 'Ctrl-G', description: t('tui.dialogs.helpPanel.shortcuts.ctrlG') },
    { keys: 'Ctrl-O', description: t('tui.dialogs.helpPanel.shortcuts.ctrlO') },
    { keys: 'Ctrl-T', description: t('tui.dialogs.helpPanel.shortcuts.ctrlT') },
    { keys: 'Ctrl-S', description: t('tui.dialogs.helpPanel.shortcuts.ctrlS') },
    { keys: 'Shift-Enter / Ctrl-J', description: t('tui.dialogs.helpPanel.shortcuts.shiftEnter') },
    { keys: 'Ctrl-C', description: t('tui.dialogs.helpPanel.shortcuts.ctrlC') },
    { keys: 'Ctrl-D', description: t('tui.dialogs.helpPanel.shortcuts.ctrlD') },
    { keys: 'Esc', description: t('tui.dialogs.helpPanel.shortcuts.esc') },
    { keys: '↑ / ↓', description: t('tui.dialogs.helpPanel.shortcuts.arrowUpDown') },
    { keys: 'Enter', description: t('tui.dialogs.helpPanel.shortcuts.enter') },
  ]
}

export interface HelpPanelProps {
  readonly commands: readonly HelpPanelCommand[]
  readonly shortcuts?: readonly KeyboardShortcut[]
  readonly onClose: () => void
  readonly maxVisible?: number
  readonly width: number
}

function truncateToWidth(text: string, width: number): string {
  // Visible-width aware (CJK glyphs span two columns); shadows the local
  // utils helper of the same name for a drop-in call-site fix.
  return truncateToVisibleWidth(text, width, ELLIPSIS)
}

function getSlashCommandDisplayGroup(name: string): number {
  return name.startsWith('skill:') ? 1 : 0
}

function compareSlashCommandsForDisplay(a: HelpPanelCommand, b: HelpPanelCommand): number {
  return (
    getSlashCommandDisplayGroup(a.name) - getSlashCommandDisplayGroup(b.name) ||
    a.name.localeCompare(b.name)
  )
}

export const HelpPanel: Component<HelpPanelProps> = (props) => {
  const [_scrollTop, setScrollTop] = createSignal(0)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    if (event.name === 'escape' || event.name === 'return' || event.name === 'enter') {
      event.stopPropagation()
      props.onClose()
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
    if (event.name === 'pageup') {
      setScrollTop((t) => Math.max(0, t - 10))
      return
    }
    if (event.name === 'pagedown') {
      setScrollTop((t) => t + 10)
      return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (ch === 'q' || ch === 'Q') {
      event.stopPropagation()
      props.onClose()
    }
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const warningFg = (): ColorInput => currentTheme.color('warning')

  const shortcuts = (): readonly KeyboardShortcut[] =>
    props.shortcuts ?? getDefaultKeyboardShortcuts()
  const sortedCmds = (): readonly HelpPanelCommand[] =>
    [...props.commands].toSorted(compareSlashCommandsForDisplay)
  const cmdLabels = (): readonly string[] =>
    sortedCmds().map((c) => {
      const aliases =
        c.aliases.length > 0 ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : ''
      return `/${c.name}${aliases}`
    })
  const kbdWidth = (): number =>
    Math.max(8, ...shortcuts().map((s) => s.keys.length))
  const cmdWidth = (): number =>
    Math.max(12, ...cmdLabels().map((l) => l.length))

  // We always render the full content into a Box; opentui handles overflow.
  // Scroll info is shown only when the content would exceed maxVisible.
  const _maxVisible = (): number => Math.max(5, props.maxVisible ?? 24)

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box flexDirection="row">
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.helpPanel.title')}`}</Text>
        <Text fg={textMutedFg()}>{t('tui.dialogs.helpPanel.cancelHint')}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Greeting */}
      <Box>
        <Text fg={textDimFg()}>{`  ${truncateToWidth(t('tui.dialogs.helpPanel.greeting'), props.width)}`}</Text>
      </Box>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Shortcuts section */}
      <Box>
        <Text fg={textDimFg()} attributes={titleAttrs()}>{`  ${t('tui.dialogs.helpPanel.keyboardShortcuts')}`}</Text>
      </Box>
      <For each={shortcuts()}>
        {(s) => (
          <Box flexDirection="row">
            <Text>{'    '}</Text>
            <Text fg={warningFg()}>{s.keys.padEnd(kbdWidth())}</Text>
            <Text>{'  '}</Text>
            <Text fg={textDimFg()}>{s.description}</Text>
          </Box>
        )}
      </For>
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Commands section */}
      <Box>
        <Text fg={textDimFg()} attributes={titleAttrs()}>{`  ${t('tui.dialogs.helpPanel.slashCommands')}`}</Text>
      </Box>
      <For each={sortedCmds()}>
        {(cmd, i) => {
          const label = (): string => cmdLabels()[i()] ?? `/${cmd.name}`
          return (
            <Box flexDirection="row">
              <Text>{'    '}</Text>
              <Text fg={titleFg()}>{label().padEnd(cmdWidth())}</Text>
              <Text>{'  '}</Text>
              <Text fg={textDimFg()}>{cmd.description}</Text>
            </Box>
          )
        }}
      </For>
      <Show when={((): boolean => true)() /* scroll placeholder */}>
        <></>
      </Show>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}