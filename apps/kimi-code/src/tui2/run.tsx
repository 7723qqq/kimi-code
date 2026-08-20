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
 * The default Shell wires the base keymap to a no-op submit handler
 * and mounts the MainShell with a host-bound dispatch.
 *
 * The real submit path lives in the KimiTUI editor-keyboard controller
 * (started in parallel by `runKimiTui2`). The keymap stub keeps the
 * boot check happy: pressing Enter in the boot-check terminal echoes
 * the typed text into the transcript slice (visible in the next frame)
 * and clears the editor.
 */
export const Shell = (renderer: CliRenderer, host: KimiTUI) => () => {
  const store = useTui2Store()
  const [termSize] = createSignal(renderer.getTerminalSize())
  const [editorValue, setEditorValue] = createSignal('')
  const dispatch = hostToDispatch(host)

  const handlers: Tui2CommandHandlers = {
    'tui2.send': () => {
      const v = editorValue().trim()
      if (v.length === 0) return
      // Boot-check only: stamp the typed text into the transcript so the
      // boot smoke-test has something to render. The real path lives in
      // KimiTUI.editorKeyboard.
      store.setState('transcript', (entries) => [
        ...entries,
        {
          id: `user-${Date.now()}`,
          kind: 'user' as const,
          renderMode: 'plain' as const,
          content: v,
          modelText: false,
        },
      ])
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
          // Boot-check path: emit a transcript entry. The real host
          // editor-keyboard controller takes over once `host.start()` has
          // mounted; its submit handler is wired to `host.sendNormalUserInput`
          // (or a queue-side equivalent) instead.
          store.setState('transcript', (entries) => [
            ...entries,
            {
              id: `user-${Date.now()}`,
              kind: 'user' as const,
              renderMode: 'plain' as const,
              content: text,
              modelText: false,
            },
          ])
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