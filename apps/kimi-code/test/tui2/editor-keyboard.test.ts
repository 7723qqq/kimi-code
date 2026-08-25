/**
 * Tests for `EditorKeyboardController` — editor-level key handling:
 * Ctrl+C / Ctrl+D double-tap exit, Esc dismissal + double-esc undo, plan
 * toggle (incl. the v2 lazy-session path) and change clearing a pending exit.
 *
 * The host surface is large (30+ methods); the mock supplies real `vi.fn`
 * spies for the methods each branch touches and casts the rest. The focus is
 * the observable branch outcome (host.stop / hideSessionPicker /
 * openUndoSelector / handlePlanToggle / ensureSession / editorDraft), not the
 * private compaction/stream internals.
 */

import { describe, expect, it, vi } from 'vitest'

import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk'

import { EditorKeyboardController, type EditorKeyboardHost } from '@/tui2/controllers/editor-keyboard'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { ImageAttachmentStore } from '@/tui2/utils/image-attachment-store'

function make(overrides?: Partial<EditorKeyboardHost>): {
  store: Tui2Store
  host: EditorKeyboardHost
  ctrl: EditorKeyboardController
} {
  const store = createTui2Store()
  const host = {
    store,
    session: undefined,
    engineV2: true,
    harness: {} as KimiHarness,
    cancelInFlight: undefined,
    btwPanelController: {
      cancelRunning: (): boolean => false,
      closeOrCancel: (): boolean => false,
    },
    handleUserInput: vi.fn(),
    steerMessage: vi.fn(),
    validateMediaCapabilities: vi.fn(() => true),
    recallLastQueued: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
    updateEditorBorderHighlight: vi.fn(),
    updateQueueDisplay: vi.fn(),
    toggleToolOutputExpansion: vi.fn(),
    toggleTodoPanelExpansion: vi.fn(),
    detachCurrentForegroundTask: vi.fn(),
    cancelRunningShellCommand: vi.fn(),
    hideSessionPicker: vi.fn(),
    openUndoSelector: vi.fn(),
    stop: vi.fn(async () => {}),
    ensureSession: vi.fn(() => Promise.resolve({} as Session)),
    handlePlanToggle: vi.fn(),
    handleInputModeChange: vi.fn(),
    clearQueuedMessages: vi.fn(),
    setExternalEditorRunning: vi.fn(),
    updateActivityPane: vi.fn(),
    runSlashCommand: vi.fn(),
    showWhichKey: vi.fn(),
    showLeaderOverlay: vi.fn(),
    hideLeaderOverlay: vi.fn(),
    toggleActivityPane: vi.fn(),
    toggleAgentPane: vi.fn(),
    toggleDiffReviewPane: vi.fn(),
    stopForExternalEditor: vi.fn(),
    startAfterExternalEditor: vi.fn(),
    ...overrides,
  } as unknown as EditorKeyboardHost
  return { store, host, ctrl: new EditorKeyboardController(host, {} as ImageAttachmentStore) }
}

describe('EditorKeyboardController', () => {
  it('routes submits to the host send path', () => {
    const { host, ctrl } = make()
    ctrl.handleSubmit('go')
    expect(host.handleUserInput).toHaveBeenCalledWith('go')
  })

  it('Ctrl+C cancels an in-flight operation once', () => {
    const cancel = vi.fn()
    const { store, host, ctrl } = make({ cancelInFlight: cancel })
    store.setState('editorDraft', 'draft')
    ctrl.handleCtrlC()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(host.cancelInFlight).toBeUndefined()
    // The exit was consumed by the in-flight cancel — no double-tap arm.
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('Ctrl+C double-tap on an idle editor exits', () => {
    const { host, ctrl } = make()
    ctrl.handleCtrlC()
    expect(host.stop).not.toHaveBeenCalled()
    ctrl.handleCtrlC()
    expect(host.stop).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+C with a non-empty draft clears the draft instead of arming exit', () => {
    const { store, host, ctrl } = make()
    store.setState('editorDraft', 'hi')
    ctrl.handleCtrlC()
    expect(store.state.editorDraft).toBe('')
    // Not a double-tap arm yet — a follow-up Ctrl+C arms exit, not stops.
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('Ctrl+C during a stream clears a live draft, not the stream', () => {
    const { store, host, ctrl } = make()
    store.setState('streamingPhase', 'composing')
    store.setState('editorDraft', 'live')
    ctrl.handleCtrlC()
    expect(store.state.editorDraft).toBe('')
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('Ctrl+D double-tap exits', () => {
    const { host, ctrl } = make()
    ctrl.handleCtrlD()
    expect(host.stop).not.toHaveBeenCalled()
    ctrl.handleCtrlD()
    expect(host.stop).toHaveBeenCalledTimes(1)
  })

  it('Esc with the session picker open hides it', () => {
    const { store, host, ctrl } = make()
    store.setState('activeDialog', 'session-picker')
    ctrl.handleEscape()
    expect(host.hideSessionPicker).toHaveBeenCalledTimes(1)
  })

  it('Esc double-tap while idle opens the undo selector', () => {
    const { host, ctrl } = make()
    ctrl.handleEscape()
    expect(host.openUndoSelector).not.toHaveBeenCalled()
    ctrl.handleEscape()
    expect(host.openUndoSelector).toHaveBeenCalledTimes(1)
  })

  it('handleChange clears a pending exit and refires the border highlight', () => {
    const { host, ctrl } = make()
    ctrl.handleCtrlC() // arm a pending ctrl-c exit (idle, empty draft)
    ctrl.handleChange('abc')
    expect(host.updateEditorBorderHighlight).toHaveBeenCalledWith('abc')
    // The pending exit was cleared, so the next Ctrl+C arms (does not stop).
    ctrl.handleCtrlC()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('Shift+Tab without a session lazy-creates it in v2 before toggling plan', async () => {
    const { host, ctrl } = make()
    ctrl.handleShiftTab()
    expect(host.ensureSession).toHaveBeenCalledTimes(1)
    expect(host.handlePlanToggle).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(host.handlePlanToggle).toHaveBeenCalledWith(true)
  })

  it('Shift+Tab with no session and v1 shows an error instead', () => {
    const { host, ctrl } = make({ engineV2: false })
    ctrl.handleShiftTab()
    expect(host.ensureSession).not.toHaveBeenCalled()
    expect(host.showError).toHaveBeenCalledTimes(1)
    expect(host.handlePlanToggle).not.toHaveBeenCalled()
  })

  it('Shift+Tab with an active session toggles plan immediately', () => {
    const { host, ctrl } = make({ session: {} as Session })
    ctrl.handleShiftTab()
    expect(host.handlePlanToggle).toHaveBeenCalledWith(true)
    expect(host.ensureSession).not.toHaveBeenCalled()
  })
})