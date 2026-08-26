/**
 * Tests for `createClipboardImageHintController` — the transient footer hint
 * shown when the clipboard gains an image the model can ingest.
 *
 * The tui2 controller is store-driven (`footerTransientHint`) and armed by
 * terminal focus-reporting input. The clipboard reader is mocked (it reads
 * the real OS clipboard, which is environment-dependent); real timers are
 * replaced with fake ones to drive the debounce / display windows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClipboardImageHintController } from '@/tui2/controllers/clipboard-image-hint'
import { FOCUS_DEBOUNCE_MS, HINT_DISPLAY_MS } from '@/tui2/constant/clipboard-image-hint'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import { TERMINAL_FOCUS_IN } from '@/tui2/utils/terminal-focus'

// Replace the real OS-clipboard reader so tests never touch the environment.
const clipboardHasImage = vi.hoisted(() => vi.fn())
vi.mock('@/utils/clipboard/clipboard-has-image', () => ({ clipboardHasImage }))

function setup(options?: { modelSupportsImage?: boolean }): {
  store: Tui2Store
  onRawInput: ReturnType<typeof vi.fn>
  emit: (data: string) => void
  controller: ReturnType<typeof createClipboardImageHintController>
} {
  const store = createTui2Store()
  let listener: ((data: string) => void) | undefined
  const onRawInput = vi.fn((fn: (data: string) => void) => {
    listener = fn
    return () => {
      listener = undefined
    }
  })
  const controller = createClipboardImageHintController({
    store,
    onRawInput,
    getModelSupportsImage: () => options?.modelSupportsImage ?? true,
  })
  const emit = (data: string): void => listener?.(data)
  return { store, onRawInput, emit, controller }
}

beforeEach(() => {
  vi.useFakeTimers()
  clipboardHasImage.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Wait for the mocked clipboard promise and any scheduled timer to settle. */
async function settle(ms = 0): Promise<void> {
  vi.advanceTimersByTime(ms)
  await Promise.resolve()
  await Promise.resolve()
}

describe('createClipboardImageHintController', () => {
  it('establishes a silent baseline at start and hints only after a new image', async () => {
    const { store, emit, controller } = setup()
    // Baseline: clipboard empty at startup.
    clipboardHasImage.mockResolvedValue(false)
    controller.start()
    await settle()
    expect(store.state.footerTransientHint).toBeNull()

    // A focus event re-checks; now the clipboard holds an image.
    clipboardHasImage.mockResolvedValue(true)
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)

    expect(store.state.footerTransientHint).not.toBeNull()
    expect(store.state.footerTransientHint).toContain('V')
  })

  it('clears the hint after the display window elapses', async () => {
    const { store, emit, controller } = setup()
    clipboardHasImage.mockResolvedValue(false)
    controller.start()
    await settle()

    clipboardHasImage.mockResolvedValue(true)
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(store.state.footerTransientHint).not.toBeNull()

    await settle(HINT_DISPLAY_MS)
    expect(store.state.footerTransientHint).toBeNull()
  })

  it('does not re-notify the same lingering image, then re-arms when empty', async () => {
    const { store, emit, controller } = setup()
    clipboardHasImage.mockResolvedValue(false)
    controller.start()
    await settle()

    // First image appears -> hint.
    clipboardHasImage.mockResolvedValue(true)
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(store.state.footerTransientHint).not.toBeNull()
    // Clear the display timer so we observe the disarm, not the expiry below.
    await settle(HINT_DISPLAY_MS)

    // Same image still present: focus again must NOT re-hint while disarmed.
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(store.state.footerTransientHint).toBeNull()

    // Clipboard becomes empty -> re-arm.
    clipboardHasImage.mockResolvedValue(false)
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)

    // A brand-new image now notifies again.
    clipboardHasImage.mockResolvedValue(true)
    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)
    expect(store.state.footerTransientHint).not.toBeNull()
  })

  it('does not read the clipboard when the model cannot ingest images', async () => {
    const { store, emit, controller } = setup({ modelSupportsImage: false })
    clipboardHasImage.mockResolvedValue(true)
    controller.start()
    await settle()

    emit(TERMINAL_FOCUS_IN)
    await settle(FOCUS_DEBOUNCE_MS)

    expect(clipboardHasImage).not.toHaveBeenCalled()
    expect(store.state.footerTransientHint).toBeNull()
  })
})