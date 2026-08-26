/**
 * Leader-chord wiring test: tui2's keymap binds Ctrl+X <key> chords that
 * dispatch `tui2.leader.<action>` commands. These depend on opentui's emacs
 * sequence parser (registered by createTui2Keymap) to compile the
 * space-separated key into a two-stroke sequence — without it every leader
 * shortcut silently stops working. Also pins the which-key / plan-mode
 * bindings.
 */
import { describe, expect, it } from 'vitest'

import { createTestRenderer } from '@opentui/core/testing'

import {
  buildBaseBindings,
  createTui2Keymap,
  leaderCommand,
  COMMANDS,
} from '../../src/tui2/keymap'
import { LEADER_CHORDS } from '../../src/tui2/keybindings'

describe('tui2 leader-chord keymap', () => {
  it('registers a binding for every leader chord (ctrl+x <key>)', () => {
    const bindings = buildBaseBindings()
    const keys = bindings.map((b) => b.key)
    for (const { key, action } of LEADER_CHORDS) {
      expect(keys).toContain(`ctrl+x ${key}`)
      expect(leaderCommand(action)).toBe(`tui2.leader.${action}`)
    }
  })

  it('dispatches ctrl+x s to the tui2.leader.status command through createTui2Keymap', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    // The real keymap factory registers the emacs parser the chords need.
    const keymap = createTui2Keymap(renderer)

    let invoked: string | undefined
    keymap.registerLayer({
      commands: [
        {
          name: leaderCommand('status'),
          run: () => {
            invoked = leaderCommand('status')
          },
        },
      ],
      bindings: buildBaseBindings().filter((b) => b.key === 'ctrl+x s'),
    })

    mockInput.pressKey('x', { ctrl: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    mockInput.pressKey('s')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(invoked).toBe(leaderCommand('status'))

    renderer.destroy()
  })

  it('does not fire a leader chord when the second key is a different key', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    const keymap = createTui2Keymap(renderer)

    let invoked: string | undefined
    keymap.registerLayer({
      commands: [
        {
          name: leaderCommand('status'),
          run: () => {
            invoked = leaderCommand('status')
          },
        },
      ],
      bindings: buildBaseBindings().filter((b) => b.key === 'ctrl+x s'),
    })

    mockInput.pressKey('x', { ctrl: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    mockInput.pressKey('m')
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(invoked).toBeUndefined()

    renderer.destroy()
  })

  it('binds ctrl+alt+k to which-key and shift+tab to plan toggle', () => {
    const bindings = buildBaseBindings()
    expect(bindings.some((b) => b.key === 'ctrl+alt+k' && b.cmd === COMMANDS.whichKey)).toBe(true)
    expect(bindings.some((b) => b.key === 'shift+tab' && b.cmd === COMMANDS.togglePlan)).toBe(true)
  })
})