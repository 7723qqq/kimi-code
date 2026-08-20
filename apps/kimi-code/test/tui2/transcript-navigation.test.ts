/**
 * Tests for `createTranscriptNavController` — keyboard-driven navigation
 * over navigable transcript entries (`j`/`k`/↑/↓`, `Enter` expand,
 * `Esc` exit).
 *
 * Unlike the v1 walking of the pi-tui Container tree, the tui2 controller
 * is pure store logic: it reads `store.state.transcriptNav` and flags
 * entries via `navigated` / `expanded`. These tests pin that contract —
 * which kinds are focusable, wrap-around, per-entry flags and the key
 * mapping.
 */

import { describe, expect, it } from 'vitest'

import { createTranscriptNavController } from '@/tui2/controllers/transcript-navigation'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { TranscriptEntry } from '@/tui2/types'

function seed(store: Tui2Store, entries: TranscriptEntry[]): void {
  store.setState('transcript', entries)
}

/** The focused (navigated) entry in the store transcript. */
function focused(store: Tui2Store): string | undefined {
  return store.state.transcript.find((e) => e.navigated === true)?.id
}

describe('createTranscriptNavController', () => {
  const mine = (): { store: Tui2Store; nav: ReturnType<typeof createTranscriptNavController> } => {
    const store = createTui2Store()
    return { store, nav: createTranscriptNavController(store) }
  }

  it('does not activate with an empty transcript', () => {
    const { store, nav } = mine()
    nav.activate()
    expect(nav.isActive()).toBe(false)
    expect(store.state.transcriptNav.active).toBe(false)
  })

  it('activates on the first navigable entry, skipping non-navigable kinds', () => {
    const { store, nav } = mine()
    // `status` is not a NAVIGABLE_KIND — activation must land on `user`.
    seed(store, [
      { id: 's', kind: 'status', renderMode: 'plain', content: 'boot' },
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 'a1', kind: 'assistant', renderMode: 'markdown', content: 'reply' },
    ])
    nav.activate()
    expect(nav.isActive()).toBe(true)
    expect(store.state.transcriptNav.active).toBe(true)
    expect(store.state.transcriptNav.index).toBe(0)
    expect(focused(store)).toBe('u1')
  })

  it('moves between navigable entries and re-flags the focus', () => {
    const { store, nav } = mine()
    seed(store, [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 's1', kind: 'status', renderMode: 'plain', content: 'skip-me' },
      { id: 'a1', kind: 'assistant', renderMode: 'markdown', content: 'reply' },
      { id: 't1', kind: 'thinking', renderMode: 'plain', content: 'thinking' },
    ])
    nav.activate()
    nav.move(1) // u1 -> a1 (s1 skipped)
    expect(store.state.transcriptNav.index).toBe(1)
    expect(focused(store)).toBe('a1')
    nav.move(1) // a1 -> t1
    expect(focused(store)).toBe('t1')
    // Previous focus is cleared.
    expect(store.state.transcript.find((e) => e.id === 'a1')?.navigated).toBe(false)
  })

  it('wraps around the navigable list at the edges', () => {
    const { store, nav } = mine()
    seed(store, [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 's1', kind: 'status', renderMode: 'plain', content: 'skip' },
      { id: 'a1', kind: 'assistant', renderMode: 'markdown', content: 'reply' },
    ])
    nav.activate()
    nav.move(1) // index 1 (a1)
    nav.move(1) // wraps to index 0 (u1)
    expect(store.state.transcriptNav.index).toBe(0)
    expect(focused(store)).toBe('u1')
    nav.move(-1) // wraps back to a1
    expect(store.state.transcriptNav.index).toBe(1)
    expect(focused(store)).toBe('a1')
  })

  it('Enter toggles expansion only on expandable kinds', () => {
    const { store, nav } = mine()
    seed(store, [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 't1', kind: 'thinking', renderMode: 'plain', content: 'think' },
    ])
    nav.activate() // focus u1 (not expandable)
    nav.toggleExpandFocused()
    expect(store.state.transcript.find((e) => e.id === 'u1')?.expanded).toBeUndefined()

    nav.move(1) // focus t1 (expandable)
    nav.toggleExpandFocused()
    expect(store.state.transcript.find((e) => e.id === 't1')?.expanded).toBe(true)
    nav.toggleExpandFocused()
    expect(store.state.transcript.find((e) => e.id === 't1')?.expanded).toBe(false)
  })

  it('maps j/k/arrows to movement and Esc/Enter to navigation actions', () => {
    const { store, nav } = mine()
    seed(store, [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 't1', kind: 'thinking', renderMode: 'plain', content: 'think' },
    ])
    nav.activate()
    expect(nav.handleKey('j')).toBe(true) // move down
    expect(store.state.transcriptNav.index).toBe(1)
    expect(nav.handleKey('\u001B[A')).toBe(true) // up arrow
    expect(store.state.transcriptNav.index).toBe(0)
    expect(nav.handleKey('k')).toBe(true) // move up (wraps)
    expect(store.state.transcriptNav.index).toBe(1)
    expect(nav.handleKey('\r')).toBe(true) // expand focused thinking
    expect(store.state.transcript.find((e) => e.id === 't1')?.expanded).toBe(true)
    expect(nav.handleKey('\u001B')).toBe(true) // esc exits
    expect(nav.isActive()).toBe(false)
  })

  it('returns false for keys while inactive and ignores unknown keys while active', () => {
    const { store, nav } = mine()
    seed(store, [{ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' }])
    expect(nav.handleKey('j')).toBe(false) // not active yet
    nav.activate()
    expect(nav.handleKey('x')).toBe(false) // unknown key not consumed
    expect(nav.handleKey('x')).toBe(false)
  })

  it('deactivate clears the navigated flag', () => {
    const { store, nav } = mine()
    seed(store, [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' },
      { id: 'a1', kind: 'assistant', renderMode: 'markdown', content: 'r' },
    ])
    nav.activate()
    expect(focused(store)).toBe('u1')
    nav.deactivate()
    expect(nav.isActive()).toBe(false)
    expect(store.state.transcript.some((e) => e.navigated === true)).toBe(false)
  })

  it('toggle flips active state on and off', () => {
    const { store, nav } = mine()
    seed(store, [{ id: 'u1', kind: 'user', renderMode: 'plain', content: 'hi' }])
    nav.toggle()
    expect(nav.isActive()).toBe(true)
    nav.toggle()
    expect(nav.isActive()).toBe(false)
  })
})