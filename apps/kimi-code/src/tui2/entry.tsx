/** @jsxImportSource @opentui/solid */
/**
 * TUI2 entry — run the interactive shell.
 *
 * Bootstraps opentui, builds the response store, installs the keymap and the
 * provider stack, and mounts a minimal session UI driven entirely by the
 * store (no imperative `addChild` / `requestRender`). This is the seed the
 * full KimiTUI v2 grows from: components read `store.state` slices and the
 * opentui reconciler re-renders on mutation.
 *
 * Run with Bun in a real terminal:
 *   bun src/tui2/entry.tsx
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import { createSignal, Show } from 'solid-js'
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { KeymapProvider, useBindings } from '@opentui/keymap/solid'

import { Tui2ProviderStack, useTui2Store } from './context'
import { createTui2Store } from './state'
import { buildBaseLayer, createTui2Keymap, type Tui2CommandHandlers } from './keymap'

function SessionShell() {
  const store = useTui2Store()
  const [draft, setDraft] = createSignal('')

  const handlers: Tui2CommandHandlers = {
    'tui2.send': () => {
      const text = draft()
      if (text.length === 0) return
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
      store.setState('streams', '1', { assistantText: `echo: ${text}`, thinkingText: '', toolCalls: {} })
      setDraft('')
    },
    'tui2.cancel': () => setDraft(''),
    'tui2.exit': () => {
      // handled by the renderer's exit flow; no-op here for boot check
    },
  }
  useBindings(() => buildBaseLayer(handlers))

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1}>
        <Show when={store.state.transcript.length === 0} fallback={<></>}>
          <text fg="#6B6B6B">(type and press Enter to send; ctrl+c to exit)</text>
        </Show>
        {store.state.transcript.map((entry) => (
          <text fg="#E0E0E0">{entry.content}</text>
        ))}
      </box>
      <box flexDirection="row">
        <text fg="#4FA8FF">&gt; </text>
        <text>{draft()}</text>
      </box>
    </box>
  )
}

export async function runTui2(input?: { workDir?: string }): Promise<void> {
  const renderer = await createCliRenderer({ screenMode: 'main-screen', exitOnCtrlC: false })
  const store = createTui2Store({ workDir: input?.workDir })
  const keymap = createTui2Keymap(renderer)

  // opentui's `render()` only resolves once the renderer is destroyed, so the
  // boot-check destroy must run on a timer that is scheduled *before* we await
  // render — gating it behind `await render` would deadlock (render never
  // resolves until destroy is called).
  if (process.env['KIMI_TUI2_BOOT_CHECK'] === '1') {
    setTimeout(() => {
      renderer.destroy()
      process.stdout.write('TUI2_ENTRY_BOOT_OK\n')
    }, 300)
  }
  await render(
    () => (
      <KeymapProvider keymap={keymap}>
        <Tui2ProviderStack store={store}>
          <SessionShell />
        </Tui2ProviderStack>
      </KeymapProvider>
    ),
    renderer,
  )
}

if (import.meta.main) {
  await runTui2()
}
