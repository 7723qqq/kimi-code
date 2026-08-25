/** @jsxImportSource @opentui/solid */
/**
 * Interactive TUI2 skeleton — a runnable proof that the opentui interaction
 * loop (keyboard -> state -> re-render) works as a real, live terminal app,
 * not a static preview.
 *
 * Run with Bun in a real terminal:
 *   bun src/tui2/demo-interactive.tsx
 *
 * This is the foundation the full interactive KimiTUI v2 grows from: a
 * live render loop + keyboard handling + reactive SolidJS state + an
 * input/echo cycle. Production entry (`kimi-tui.ts`) will wire the real
 * session/streaming controllers onto this same loop.
 *
 * Status: REAL (tui2) interactive demo / skeleton.
 */

import { createSignal } from 'solid-js'
import { createCliRenderer } from '@opentui/core'
import { render, useKeyboard } from '@opentui/solid'

export function InteractiveSkeleton() {
  const [typed, setTyped] = createSignal('')
  const [lines, setLines] = createSignal<readonly string[]>([])
  const [status, setStatus] = createSignal('ready')

  useKeyboard((key) => {
    if (key.sequence === '\r') {
      const val = typed()
      setStatus(`sent ${lines().length + 1}`)
      if (val.length > 0) setLines((prev) => [...prev, val])
      setTyped('')
      return
    }
    if (key.name === 'backspace') {
      setTyped((prev) => prev.slice(0, -1))
      return
    }
    if (key.name === 'escape') {
      setStatus('escaped')
      return
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      setTyped((prev) => prev + key.name)
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1}>
        {lines().length === 0 ? (
          <text fg="#6B6B6B">(type a line and press Enter; Esc shows status; Ctrl+C exits)</text>
        ) : (
          lines().map((line, i) => (
            <text fg="#4FA8FF">
              {String(i + 1)}&gt; {line}
            </text>
          ))
        )}
      </box>
      <box flexDirection="row">
        <text fg="#4FA8FF">&gt; </text>
        <text>{typed()}</text>
      </box>
      <text fg="#888888">status: {status()}</text>
    </box>
  )
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ screenMode: 'main-screen' })
  await render(InteractiveSkeleton, renderer)
  // Non-interactive boot check: render a frame, then exit so a CI shell can
  // confirm the renderer + interaction loop boot cleanly without a human.
  if (process.env['KIMI_TUI2_BOOT_CHECK'] === '1') {
    renderer.requestRender()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300)
    })
    renderer.destroy()
    process.stdout.write('TUI2_SKELETON_BOOT_OK\n')
  }
}
