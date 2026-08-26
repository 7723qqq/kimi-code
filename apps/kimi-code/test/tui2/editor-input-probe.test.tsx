/** @jsxImportSource @opentui/solid */
/**
 * Editor input routing regression tests (formerly an exploration probe).
 *
 * Two layers make ↑/↓ history recall, autocomplete navigation and
 * Enter/Tab suggestion selection work in tui2:
 *   1. the opentui keymap accepts bindings/intercepts for these keys, so the
 *      routing can live above the editor renderable;
 *   2. `createEditorKeyInterceptor` (run.tsx) consumes them only while the
 *      main editor owns focus, forwarding to the editor-keyboard controller.
 *
 * These tests pin both layers so refactors of either side fail loudly here.
 */
import { describe, expect, it, vi } from 'vitest'

import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui'
import { createTestRenderer } from '@opentui/core/testing'
import type { KeyEvent } from '@opentui/core'

import { createEditorKeyInterceptor } from '@/tui2/run'
import { createTui2Store, type Tui2Store } from '@/tui2/state'

function fakeKey(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: '',
    number: false,
    raw: '',
    eventType: 'press',
    source: 'raw',
    ...mods,
  } as KeyEvent
}

function interceptorHarness(store?: Tui2Store) {
  const settledStore = store ?? createTui2Store()
  const editorKeyboard = {
    handleUpArrowEmpty: vi.fn(),
    handleDownArrowEmpty: vi.fn(),
    acceptAutocomplete: vi.fn(() => true),
  }
  const consume = vi.fn()
  const intercept = createEditorKeyInterceptor({
    store: settledStore,
    editorKeyboard,
  })
  const press = (key: KeyEvent): void => {
    intercept({ event: key, consume })
  }
  return { store: settledStore, editorKeyboard, consume, press }
}

describe('opentui input key passthrough', () => {
  it('accepts tab / up / down bindings at the keymap layer', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    const keymap = createDefaultOpenTuiKeymap(renderer)

    const fired: string[] = []
    keymap.registerLayer({
      commands: [
        {
          name: 'test.tab',
          run: () => {
            fired.push('tab')
          },
        },
        {
          name: 'test.down',
          run: () => {
            fired.push('down')
          },
        },
        {
          name: 'test.up',
          run: () => {
            fired.push('up')
          },
        },
      ],
      bindings: [
        { key: 'tab', cmd: 'test.tab' },
        { key: 'down', cmd: 'test.down' },
        { key: 'up', cmd: 'test.up' },
      ],
    })

    mockInput.pressTab()
    await new Promise((resolve) => setTimeout(resolve, 50))
    mockInput.pressArrow('down')
    await new Promise((resolve) => setTimeout(resolve, 50))
    mockInput.pressArrow('up')
    await new Promise((resolve) => setTimeout(resolve, 50))

    renderer.destroy()

    // Documents that the keymap accepts these bindings: the editor layer can
    // dispatch them (the actual input-focus passthrough is exercised by the
    // real terminal boot smoke test).
    expect(fired).toEqual(['tab', 'down', 'up'])
  })
})

describe('createEditorKeyInterceptor', () => {
  it('consumes ↑/↓ while the editor owns focus and forwards to recall', () => {
    const { editorKeyboard, consume, press } = interceptorHarness()
    press(fakeKey('up'))
    expect(editorKeyboard.handleUpArrowEmpty).toHaveBeenCalledTimes(1)
    press(fakeKey('down'))
    expect(editorKeyboard.handleDownArrowEmpty).toHaveBeenCalledTimes(1)
    expect(consume).toHaveBeenCalledTimes(2)
  })

  it('ignores keys while a dialog or editor replacement holds the slot', () => {
    const { store, editorKeyboard, consume, press } = interceptorHarness()
    store.setState('activeDialog', 'session-picker')
    press(fakeKey('up'))
    expect(editorKeyboard.handleUpArrowEmpty).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()

    store.setState('activeDialog', null)
    store.setState('editorReplacement', {
      component: () => null,
      props: {},
    })
    press(fakeKey('up'))
    expect(editorKeyboard.handleUpArrowEmpty).not.toHaveBeenCalled()
  })

  it('consumes Enter / Tab only when a popup selection was applied', () => {
    const { store, editorKeyboard, consume, press } = interceptorHarness()
    // No popup open: Enter falls through to the editor submit path.
    press(fakeKey('return'))
    expect(editorKeyboard.acceptAutocomplete).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()

    store.setState('editorAutocomplete', {
      items: [{ value: 'model', label: 'model' }],
      selectedIndex: 0,
      prefix: '/mod',
    })
    press(fakeKey('return'))
    expect(editorKeyboard.acceptAutocomplete).toHaveBeenCalledTimes(1)
    expect(consume).toHaveBeenCalledTimes(1)

    // Refusal to apply leaves the key unconsumed.
    editorKeyboard.acceptAutocomplete.mockReturnValueOnce(false)
    press(fakeKey('tab'))
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('routes real arrow key events end-to-end through the keymap', async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 })
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const { store, editorKeyboard } = interceptorHarness(createTui2Store())
    const offIntercept = keymap.intercept(
      'key',
      createEditorKeyInterceptor({
        store,
        editorKeyboard,
      }),
    )

    mockInput.pressArrow('up')
    await new Promise((resolve) => setTimeout(resolve, 50))

    offIntercept()
    mockInput.pressArrow('up')
    await new Promise((resolve) => setTimeout(resolve, 50))

    renderer.destroy()
    expect(editorKeyboard.handleUpArrowEmpty).toHaveBeenCalledTimes(1)
  })
})
