/** @jsxImportSource @opentui/solid */
/**
 * TUI2 KimiTUI run — wire the opentui renderer to the KimiTUI controller.
 *
 * Boots opentui, builds the response store, creates the KimiTUI
 * controller, mounts the MainShell view, and returns the booted triple.
 * The `KIMI_TUI2_BOOT_CHECK` env var makes the function exit shortly
 * after mount so CI can verify the wiring without a real terminal.
 *
 * The `Shell` exported below is the default top-level view: the base
 * keymap wired to a dispatch that forwards dialog results back to the
 * host (`host.applyDialogResult` / `host.cancelDialog`). Tests and
 * alternative entry points can swap the Shell for a custom view.
 *
 * Editor state follows the response store: the input renderable's
 * onChange writes `store.state.editorDraft` and the editor-keyboard
 * controller's `handleChange`; submit routes through
 * `editorKeyboard.handleSubmit` so history, image extraction, bash-mode
 * and slash-command dispatch all run on the real send path.
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import { createSignal } from 'solid-js'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { KeymapProvider, useBindings } from '@opentui/keymap/solid'

import { Tui2ProviderStack, useTui2Store } from './context'
import { buildBaseLayer, createTui2Keymap, type Tui2CommandHandlers, type Tui2Keymap } from './keymap'
import { createTui2Store, type Tui2Store } from './state'
import { showModelPicker } from './commands/config'
import { MainShell } from './components/main-shell'
import { KimiTUI } from './controllers/kimi-tui'
import type { DialogDispatch, DialogResult } from './dispatch'
import type { SlashCommandHost } from './commands/dispatch'

import type { CliRenderer } from '@opentui/core'

export interface RunKimiTui2Options {
  readonly harness: ConstructorParameters<typeof KimiTUI>[0]
  readonly startupInput: ConstructorParameters<typeof KimiTUI>[1]
  readonly onExit?: (exitCode?: number) => Promise<void>
  readonly exitForegroundTask?: (exitCode: number) => Promise<void>
}

export interface RunKimiTui2Result {
  readonly renderer: CliRenderer
  readonly store: Tui2Store
  readonly keymap: Tui2Keymap
  readonly host: KimiTUI
}

/**
 * Adapter from the host's `applyDialogResult` / `cancelDialog` methods
 * to the shell's `DialogDispatch` protocol. Fire-and-forget: dialog
 * callbacks return synchronously; any async work the host kicks off
 * (e.g. session switching, theme apply) is awaited inside the host.
 */
function hostToDispatch(host: KimiTUI): DialogDispatch {
  return {
    select: (result: DialogResult) => {
      void host.applyDialogResult(result)
    },
    cancel: (_kind) => {
      host.cancelDialog()
    },
  }
}

/**
 * The default Shell wires the base keymap to the host's editor-keyboard
 * controller and mounts the MainShell with a host-bound dispatch. Editor
 * text lives in `store.state.editorDraft`; Enter (or the keymap send
 * command) routes through `editorKeyboard.handleSubmit`, which owns
 * history, image extraction, bash-mode and slash-command dispatch.
 */
export const Shell = (renderer: CliRenderer, host: KimiTUI) => () => {
  const store = useTui2Store()
  // opentui's CliRenderer does not yet expose a size getter; the shell lays
  // out with these defaults until the renderer surfaces terminal dimensions.
  const [termSize] = createSignal({ width: 80, height: 24 })
  const dispatch = hostToDispatch(host)
  const editorKeyboard = host.editorKeyboard

  const submitDraft = (): void => {
    const v = store.state.editorDraft
    if (v.trim().length === 0) return
    store.setState('editorDraft', '')
    editorKeyboard.handleSubmit(v)
  }

  const handlers: Tui2CommandHandlers = {
    'tui2.send': submitDraft,
    'tui2.cancel': () => editorKeyboard.handleEscape(),
    'tui2.cancelStream': () => editorKeyboard.handleCtrlC(),
    'tui2.exit': () => editorKeyboard.handleCtrlD(),
    'tui2.editor.focus': () => {
      // opentui keeps the input focused while no dialog is open; nothing to
      // do here (kept so the command catalog is complete).
    },
    'tui2.model.switch': () => {
      // Full tabbed model picker via the editor-replacement slot.
      showModelPicker(host as unknown as SlashCommandHost)
    },
    'tui2.editor.external': () => editorKeyboard.handleOpenExternalEditor(),
    'tui2.tool.output': () => editorKeyboard.handleToggleToolExpand(),
    'tui2.queue.send': () => host.drainOneQueuedMessage(),
    'tui2.todo.expand': () => editorKeyboard.handleToggleTodoExpand(),
    'tui2.sessions': () => void host.showSessionPicker(),
    'tui2.session.new': () => void host.showSessionPicker(),
    'tui2.help': () => host.showHelpPanel(),
    'tui2.status': () => {
      // Footer status-line toggling is not wired yet; kept as a no-op so
      // the binding exists in the catalog.
    },
  }
  useBindings(() => buildBaseLayer(handlers))

  return (
    <Tui2ProviderStack store={store}>
      <MainShell
        dispatch={dispatch}
        width={termSize().width}
        height={termSize().height}
        activityMode={store.state.activityMode === 'idle' ? 'hidden' : store.state.activityMode}
        activityTip={store.state.activityTip}
        activityDetail={store.state.activityDetail}
        onEditorChange={(text) => {
          store.setState('editorDraft', text)
          editorKeyboard.handleChange(text)
        }}
        onEditorSubmit={(text) => {
          // The input renderable's own submit path (e.g. mouse click on
          // Enter) — route through the same send path as the keymap.
          if (text.trim().length === 0) return
          store.setState('editorDraft', '')
          editorKeyboard.handleSubmit(text)
        }}
      />
    </Tui2ProviderStack>
  )
}

export async function runKimiTui2(options: RunKimiTui2Options): Promise<RunKimiTui2Result> {
  const renderer = await createCliRenderer({ screenMode: 'main-screen', exitOnCtrlC: false })
  const store = createTui2Store({})
  const keymap = createTui2Keymap(renderer)

  // Tui2Terminal adapter — opentui owns the terminal directly, the
  // controller only needs write / setTitle / setProgress to keep its
  // existing surface.
  const terminal = {
    write: (data: string) => process.stdout.write(data),
    setTitle: (title: string) => renderer.setTerminalTitle(title),
    setProgress: (_active: boolean) => {
      /* opentui has no progress indicator yet */
    },
  }

  const host = new KimiTUI(options.harness, options.startupInput, terminal)
  if (options.onExit !== undefined) host.onExit = options.onExit
  host.exitForegroundTask = options.exitForegroundTask

  const ShellView = Shell(renderer, host)
  const renderPromise = render(
    () => <KeymapProvider keymap={keymap}><ShellView /></KeymapProvider>,
    renderer,
  )

  if (process.env['KIMI_TUI2_BOOT_CHECK'] === '1') {
    setTimeout(() => {
      renderer.destroy()
      process.stdout.write('TUI2_ENTRY_BOOT_OK\n')
    }, 300)
  }

  // Kick off the host's start in parallel with rendering. The host
  // updates the store; the reconciler re-renders.
  void host.start()

  await renderPromise

  return { renderer, store, keymap, host }
}
