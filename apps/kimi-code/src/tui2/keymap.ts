/**
 * TUI2 keymap — command catalog + default bindings.
 *
 * Uses `@opentui/keymap` (the same engine opencode's TUI uses) to turn
 * keyboard input into named, focus-scoped commands, replacing v1's pi-tui
 * `KeybindingsManager` + leader-chord plumbing.
 *
 * The command catalog is declared here (names + handlers) and bound to keys
 * through `Layer.commands` / `Layer.bindings`. `useBindings` (from
 * `@opentui/keymap/solid`) registers those reactively inside the component
 * tree; `dispatchCommand` runs them.
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core'
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import type { Command, Keymap, Layer } from '@opentui/keymap'

export type Tui2Keymap = Keymap<Renderable, KeyEvent>

/** Command names used by the TUI2 core shell. */
export const COMMANDS = {
  send: 'tui2.send',
  cancel: 'tui2.cancel',
  /** Ctrl+C: cancel the in-flight stream / arm the exit confirmation. */
  cancelStream: 'tui2.cancelStream',
  exit: 'tui2.exit',
  focusEditor: 'tui2.editor.focus',
  /** Ctrl+E: open the external $EDITOR with the draft. */
  externalEditor: 'tui2.editor.external',
  /** Ctrl+O: toggle tool output expansion. */
  toggleToolOutput: 'tui2.tool.output',
  /** Ctrl+S: send the oldest queued message (steer / drain). */
  sendQueued: 'tui2.queue.send',
  /** Ctrl+T: toggle the todo panel expansion. */
  toggleTodoExpand: 'tui2.todo.expand',
  switchModel: 'tui2.model.switch',
  sessions: 'tui2.sessions',
  newSession: 'tui2.session.new',
  help: 'tui2.help',
  status: 'tui2.status',
} as const

export type Tui2CommandName = (typeof COMMANDS)[keyof typeof COMMANDS]

export interface Tui2CommandHandlers {
  readonly [command: string]: (() => void) | undefined
}

/**
 * Build a `Layer.commands` array from a handlers map. Every registered
 * command is a plain named handler (no payload), which `dispatchCommand`
 * resolves by name.
 */
export function buildCommands(handlers: Tui2CommandHandlers): readonly Command<Renderable, KeyEvent>[] {
  return Object.entries(handlers)
    .filter(([, handler]) => handler !== undefined)
    .map(([name, handler]) => ({
      name,
      run: () => {
        handler?.()
      },
    }))
}

/** Default key → command bindings for the base mode. */
export function buildBaseBindings(): Layer<Renderable, KeyEvent>['bindings'] {
  return [
    // NOTE: the binding field is `cmd`, not `command`. opentui's keymap
    // compiler silently drops unknown fields (a `command` field would make
    // every shortcut a no-op), so keep these in sync with `Binding.cmd`.
    { key: 'ctrl+c', cmd: COMMANDS.cancelStream },
    { key: 'ctrl+d', cmd: COMMANDS.exit },
    { key: 'ctrl+e', cmd: COMMANDS.externalEditor },
    { key: 'ctrl+m', cmd: COMMANDS.switchModel },
    { key: 'ctrl+o', cmd: COMMANDS.toggleToolOutput },
    { key: 'ctrl+s', cmd: COMMANDS.sendQueued },
    { key: 'ctrl+t', cmd: COMMANDS.toggleTodoExpand },
    { key: 'ctrl+l', cmd: COMMANDS.sessions },
    { key: 'ctrl+n', cmd: COMMANDS.newSession },
    { key: 'escape', cmd: COMMANDS.cancel },
  ]
}

/**
 * Create the TUI2 keymap over a renderer. Uses opentui's default keymap,
 * which wires the renderer's keypress stream to a focus-aware keymap engine.
 */
export function createTui2Keymap(renderer: CliRenderer): Tui2Keymap {
  return createDefaultOpenTuiKeymap(renderer)
}

/**
 * Compose a base-mode layer (commands + bindings), shaped for `useBindings`
 * (which expects no `target`). Pass the result to `useBindings` inside a
 * component within `KeymapProvider`.
 */
export function buildBaseLayer(
  handlers: Tui2CommandHandlers,
): { commands: readonly Command<Renderable, KeyEvent>[]; bindings: Layer<Renderable, KeyEvent>['bindings'] } {
  return {
    commands: buildCommands(handlers),
    bindings: buildBaseBindings(),
  }
}
