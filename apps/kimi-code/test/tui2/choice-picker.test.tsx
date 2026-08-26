/** @jsxImportSource @opentui/solid */
/**
 * ChoicePicker component tests — the first tui2 dialog rendered through the
 * real opentui reconciler.
 *
 * Mounting note: the test file's solid-js and @opentui/solid's internal
 * solid-js are separate module instances under vitest, so signal updates
 * inside the component do not re-render the frame. These tests therefore
 * assert what is observable without cross-instance reactivity:
 *   - the initial rendered frame (title, options, current marker, hint);
 *   - key behaviour through the callbacks (onSelect / onCancel /
 *     onSessionOnlySelect), which read the component's own signals
 *     synchronously at commit time.
 */

import { describe, expect, it, vi } from 'vitest'
import type { KeyEvent } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { _render, createComponent, RendererContext } from '@opentui/solid'

import { ChoicePicker, type ChoiceOption } from '@/tui2/components/dialogs/choice-picker'

const OPTIONS: readonly ChoiceOption[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
]

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
    stopPropagation: () => {},
    ...mods,
  } as KeyEvent
}

async function mount(props: Parameters<typeof ChoicePicker>[0]): Promise<{
  renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer']
  setup: Awaited<ReturnType<typeof createTestRenderer>>
  press: (key: KeyEvent) => void
  frame: () => string
}> {
  const setup = await createTestRenderer({ width: 60, height: 20 })
  const { renderer } = setup
  _render(
    () =>
      createComponent(RendererContext.Provider, {
        get value() {
          return renderer
        },
        get children() {
          return () => createComponent(ChoicePicker, props)
        },
      }),
    renderer.root,
  )
  await setup.renderOnce()
  return {
    renderer,
    setup,
    press: (key) => renderer.keyInput.emit('keypress', key),
    frame: () => setup.captureCharFrame(),
  }
}

describe('ChoicePicker', () => {
  it('renders the title, hint, options and the current marker', async () => {
    const { frame } = await mount({
      title: 'Pick one',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: OPTIONS,
      currentValue: 'beta',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    })
    const text = frame()
    expect(text).toContain('Pick one')
    expect(text).toContain('↑↓ navigate')
    expect(text).toContain('Alpha')
    expect(text).toContain('Beta')
    expect(text).toContain('Gamma')
    // The current value is marked; the cursor starts on it.
    expect(text).toContain('← current')
  })

  it('Enter selects the option under the cursor', async () => {
    const onSelect = vi.fn()
    const { press } = await mount({
      title: 'Pick',
      options: OPTIONS,
      onSelect,
      onCancel: vi.fn(),
    })
    press(fakeKey('return'))
    expect(onSelect).toHaveBeenCalledWith('alpha')
  })

  it('↑/↓ move the cursor before committing', async () => {
    const onSelect = vi.fn()
    const { press } = await mount({
      title: 'Pick',
      options: OPTIONS,
      onSelect,
      onCancel: vi.fn(),
    })
    press(fakeKey('down'))
    press(fakeKey('down'))
    press(fakeKey('return'))
    expect(onSelect).toHaveBeenCalledWith('gamma')
    press(fakeKey('up'))
    press(fakeKey('return'))
    expect(onSelect).toHaveBeenCalledWith('beta')
  })

  it('Esc cancels; with an active query it clears the query first', async () => {
    const onCancel = vi.fn()
    const onSelect = vi.fn()
    const { press } = await mount({
      title: 'Pick',
      options: OPTIONS,
      searchable: true,
      onSelect,
      onCancel,
    })
    // No query: Esc cancels immediately.
    press(fakeKey('escape'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    // With a query: first Esc clears it, second Esc cancels.
    press(fakeKey('b'))
    press(fakeKey('escape'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    press(fakeKey('escape'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('search filters the list before committing', async () => {
    const onSelect = vi.fn()
    const { press } = await mount({
      title: 'Pick',
      options: OPTIONS,
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    })
    press(fakeKey('b'))
    press(fakeKey('return'))
    // Fuzzy filter on 'b' matches Beta (and only Beta).
    expect(onSelect).toHaveBeenCalledWith('beta')
  })

  it('Alt+S fires the session-only callback when provided', async () => {
    const onSelect = vi.fn()
    const onSessionOnlySelect = vi.fn()
    const { press } = await mount({
      title: 'Pick',
      options: OPTIONS,
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    })
    press(fakeKey('s', { option: true }))
    expect(onSessionOnlySelect).toHaveBeenCalledWith('alpha')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
