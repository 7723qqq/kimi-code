/**
 * Smoke test: verify the tui2 keymap binding path end-to-end.
 *
 * Uses @opentui/core's test renderer + mock keys to prove that a binding
 * registered through `createDefaultOpenTuiKeymap` dispatches its command
 * when the matching key is pressed. Mirrors the real keymap.ts wiring.
 */
import { describe, expect, it } from 'vitest'

import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { createTestRenderer } from '@opentui/core/testing'

describe('tui2 keymap dispatch', () => {
  it('dispatches a ctrl+e binding to its command handler', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    const keymap = createDefaultOpenTuiKeymap(renderer)

    let invoked = 0
    keymap.registerLayer({
      commands: [
        {
          name: 'test.external',
          run: () => {
            invoked++
          },
        },
      ],
      bindings: [{ key: 'ctrl+e', cmd: 'test.external' }],
    })

    mockInput.pressKey('e', { ctrl: true })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(invoked).toBe(1)

    keymap.getActiveKeys() // no-op read to keep the keymap reference live
    renderer.destroy()
  })

  it('dispatches a plain character binding on its key', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    const keymap = createDefaultOpenTuiKeymap(renderer)

    let invoked = 0
    keymap.registerLayer({
      commands: [
        {
          name: 'test.char',
          run: () => {
            invoked++
          },
        },
      ],
      bindings: [{ key: 'escape', cmd: 'test.char' }],
    })

    mockInput.pressEscape()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(invoked).toBe(1)

    renderer.destroy()
  })
})