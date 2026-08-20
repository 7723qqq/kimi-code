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
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import { createSignal } from 'solid-js'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { KeymapProvider, useBindings } from '@opentui/keymap/solid'

import { Tui2ProviderStack, useTui2Store } from './context'
import { buildBaseLayer, createTui2Keymap, type Tui2CommandHandlers, type Tui2Keymap } from './keymap'
import { createTui2Store, type Tui2Store } from './state'
import { MainShell } from './components/main-shell'
import { KimiTUI } from './controllers/kimi-tui'
import type { DialogDispatch, DialogResult } from './dispatch'

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
 * controller and mounts the MainShell with a host-bound dispatch. Pressing
 * Enter in the editor forwards the typed text to
 * `host.sendNormalUserInput`; the host owns extraction, image
 * substitution, and the actual session.sendMessage call.
 */
export const Shell = (renderer: CliRenderer, host: KimiTUI) => () => {
  const store = useTui2Store()
  const [termSize] = createSignal(renderer.getTerminalSize())
  const [editorValue, setEditorValue] = createSignal('')
  const dispatch = hostToDispatch(host)

  const handlers: Tui2CommandHandlers = {
    'tui2.send': () => {
      const v = editorValue()
      if (v.length === 0) return
      // Real send path: hand the text to the host. The host extracts
      // image attachments, builds the prompt parts, and routes through
      // session.sendMessage. The editor buffer is cleared on the host's
      // side once the message is accepted.
      void host.sendNormalUserInput(v)
      setEditorValue('')
    },
    'tui2.cancel': () => setEditorValue(''),
    'tui2.exit': () => {
      /* handled by the renderer's exit flow */
    },
  }
  useBindings(() => buildBaseLayer(handlers))

  return (
    <Tui2ProviderStack store={store}>
      <MainShell
        dispatch={dispatch}
        width={termSize().width}
        height={termSize().height}
        activityMode={store.state.activityMode}
        activityTip={store.state.activityTip}
        activityDetail={store.state.activityDetail}
        editorValue={editorValue()}
        onEditorChange={setEditorValue}
        onEditorSubmit={(text) => {
          // Defensive: the keymap also drives tui2.send. The explicit
          // submit path is used by the input renderable's own onSubmit
          // (e.g. mouse click on Enter), so route through the same
          // host call to avoid a duplicate transcript entry.
          if (text.length === 0) return
          void host.sendNormalUserInput(text)
          setEditorValue('')
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
    write: (data: string) => renderer.writeOut(data),
    setTitle: (title: string) => renderer.setTerminalTitle(title),
    setProgress: (_active: boolean) => {
      /* opentui has no progress indicator yet */
    },
  }

  const host = new KimiTUI(options.harness, options.startupInput, terminal)
  if (options.onExit !== undefined) host.onExit = options.onExit
  host.exitForegroundTask = options.exitForegroundTask

  const renderPromise = render(
    () => <KeymapProvider keymap={keymap}><Shell renderer={renderer} host={host} /></KeymapProvider>,
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