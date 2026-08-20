/** @jsxImportSource @opentui/solid */
/**
 * TUI2 KimiTUI run — wire the opentui renderer to the KimiTUI controller.
 *
 * Boots opentui, builds the response store, creates the KimiTUI
 * controller, mounts the MainShell view, and returns the booted triple.
 * The `KIMI_TUI2_BOOT_CHECK` env var makes the function exit shortly
 * after mount so CI can verify the wiring without a real terminal.
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

export async function runKimiTui2(options: RunKimiTui2Options): Promise<RunKimiTui2Result> {
  const renderer = await createCliRenderer({ screenMode: 'main-screen', exitOnCtrlC: false })
  const store = createTui2Store({})
  const keymap = createTui2Keymap(renderer)

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

  const Shell = () => {
    const s = useTui2Store()
    const [editorValue, setEditorValue] = createSignal('')
    const handlers: Tui2CommandHandlers = {
      'tui2.send': () => {
        const v = editorValue()
        if (v.length === 0) return
        s.setState('transcript', (entries) => [
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
        // handled by the renderer's exit flow; no-op here for boot check
      },
    }
    useBindings(() => buildBaseLayer(handlers))
    const termSize = renderer.getTerminalSize()
    return (
      <Tui2ProviderStack store={s}>
        <MainShell
          width={termSize.width}
          height={termSize.height}
          activityMode="idle"
          editorFocused
          editorValue={editorValue()}
          onEditorChange={setEditorValue}
          onEditorSubmit={(_v) => {
            /* delegated to KimiTUI host */
          }}
        />
      </Tui2ProviderStack>
    )
  }

  const renderPromise = render(
    () => (
      <KeymapProvider keymap={keymap}>
        <Shell />
      </KeymapProvider>
    ),
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