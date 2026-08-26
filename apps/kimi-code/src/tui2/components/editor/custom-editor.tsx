/** @jsxImportSource @opentui/solid */
/**
 * TUI2 custom editor — input box with app-level keybindings.
 *
 * Replaces the v1 `CustomEditor` (a pi-tui Editor subclass with 800+
 * lines of overrides for paste, history, leader-key, autocomplete,
 * file mentions, etc.) with an opentui SolidJS view built on opentui's
 * `<input>` renderable. Most per-key plumbing is delegated to opentui's
 * input handler; app-level shortcuts and the leader chord are consumed by
 * the host keymap before reaching the editor, ↑/↓/Enter/Tab are routed by
 * run.tsx's editor key interceptor, multi-line pastes become `[paste #N]`
 * markers (see paste-markers.ts), programmatic draft writes mirror into the
 * input through the store, and the autocomplete popup renders below the box.
 *
 * The view mirrors v1's visual contract: a `> ` prompt token (matching the
 * pi-tui diagonal), the `! shell mode` badge + `!` prompt while a `!` shell
 * command is being composed, and border/title colouring driven by the host's
 * editor-border highlight state (plan/slash context) instead of a fixed
 * focus colour.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createEffect, For, onCleanup, Show } from 'solid-js'

import type { ColorInput, InputRenderable, PasteEvent } from '@opentui/core'

import { t } from '#/i18n'

import { useTui2Store } from '../../context'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'
import { setEditorInput } from './editor-input-ref'
import {
  getPasteRegistry,
  normalizePastedText,
  pasteNeedsMarker,
} from './paste-markers'

export interface CustomEditorProps {
  readonly placeholder?: string
  readonly width?: number
  readonly onSubmit?: (value: string) => void
  readonly onChange?: (value: string) => void
  readonly focused?: boolean
}

/** Suggestions shown in the autocomplete popup before it starts scrolling. */
const AUTOCOMPLETE_MAX_VISIBLE = 8
const AUTOCOMPLETE_LABEL_WIDTH = 32

export const CustomEditor: Component<CustomEditorProps> = (props) => {
  const store = useTui2Store()
  let inputRef: InputRenderable | undefined
  // Host-maintained editor border state (plan mode / slash context / shell
  // mode). `editorToken` maps to a theme colour token like v1's borderColor
  // hook; bash mode additionally shows the `!` prompt + shell-mode badge.
  const isBash = (): boolean => store.state.inputMode === 'bash'
  const borderToken = (): 'shellMode' | 'primary' | 'border' =>
    store.state.editorBorderHighlighted
      ? store.state.editorBorderToken
      : 'border'
  const borderFg = (): ColorInput => currentTheme.color(borderToken())
  const titleFg = (): ColorInput => currentTheme.color(borderToken())
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')
  // In tui2 the `!` prefix itself lives in the editor buffer (opentui input),
  // so the prompt symbol stays `>` even in bash mode — the `! shell mode`
  // label + shellMode border carry the mode signal instead (v1 split the
  // `!` into the prompt; showing `!` here too would double it).
  const promptFg = (): ColorInput => currentTheme.color('text')
  const borderWidth = (): number => Math.max(1, (props.width ?? 40) - 2)

  // Programmatic draft writes (history recall, undo restore, external editor,
  // autocomplete selection) mirror into the input renderable. The `value`
  // setter is a no-op when the buffer already matches, so user typing echoed
  // back through the store never moves the cursor.
  createEffect(() => {
    const draft = store.state.editorDraft
    if (inputRef !== undefined && inputRef.value !== draft) {
      inputRef.value = draft
    }
  })

  // Publish the live renderable so the keyboard controller can insert at the
  // real cursor position; unregister on unmount (dialog replacing the editor).
  onCleanup(() => {
    setEditorInput(store, undefined)
    inputRef = undefined
  })

  // Multi-line / oversized pastes become `[paste #N]` markers stored in the
  // per-shell registry instead of being flattened into the single-line input
  // (v1 paste-marker semantics); the controller expands them on submit.
  const handlePaste = (event: PasteEvent): void => {
    const content = normalizePastedText(new TextDecoder().decode(event.bytes))
    if (!pasteNeedsMarker(content)) return
    event.preventDefault()
    inputRef?.insertText(getPasteRegistry(store).insert(content))
  }

  const autocomplete = (): NonNullable<typeof store.state.editorAutocomplete> | undefined =>
    store.state.editorAutocomplete ?? undefined

  return (
    <Box flexDirection="column" width="100%">
      {/* Label row: displayed only in bash mode */}
      <Show when={isBash()}>
        <Box flexDirection="row">
          <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.messages.shellModeLabel')} `}</Text>
        </Box>
      </Show>
      {/* Top border */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╭'}</Text>
        <Text fg={borderFg()}>{'─'.repeat(borderWidth())}</Text>
        <Text fg={borderFg()}>{'╮'}</Text>
      </Box>
      {/* Input row: prompt symbol + input */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'│'}</Text>
        <Text>{' '}</Text>
        <Text fg={promptFg()}>{'>'}</Text>
        <Text>{' '}</Text>
        <input
          ref={(el) => {
            inputRef = el
            setEditorInput(store, el)
          }}
          flexGrow={1}
          focused={props.focused ?? true}
          placeholder={props.placeholder ?? ''}
          onInput={(v) => props.onChange?.(v)}
          onPaste={handlePaste}
          onSubmit={(v) => {
            if (typeof v === 'string') props.onSubmit?.(v)
          }}
        />
        <Text>{' '}</Text>
        <Text fg={borderFg()}>{'│'}</Text>
      </Box>
      {/* Bottom border */}
      <Box flexDirection="row">
        <Text fg={borderFg()}>{'╰'}</Text>
        <Text fg={borderFg()}>{'─'.repeat(borderWidth())}</Text>
        <Text fg={borderFg()}>{'╯'}</Text>
      </Box>
      {/* Autocomplete popup (slash commands / file mentions) */}
      <Show when={autocomplete() !== undefined}>
        <Box flexDirection="column">
          <For each={(autocomplete()?.items ?? []).slice(0, AUTOCOMPLETE_MAX_VISIBLE)}>
            {(item, index) => {
              const selected = (): boolean => autocomplete()?.selectedIndex === index()
              const itemFg = (): ColorInput =>
                selected() ? currentTheme.color('primary') : currentTheme.color('text')
              return (
                <Box flexDirection="row">
                  <Text fg={itemFg()}>{selected() ? '› ' : '  '}</Text>
                  <Text fg={itemFg()} attributes={selected() ? currentTheme.attributes('bold') : 0}>
                    {item.label.slice(0, AUTOCOMPLETE_LABEL_WIDTH)}
                  </Text>
                  <Show when={item.description !== undefined}>
                    <Text fg={hintFg()}>{`  ${item.description ?? ''}`}</Text>
                  </Show>
                </Box>
              )
            }}
          </For>
        </Box>
      </Show>
    </Box>
  )
}