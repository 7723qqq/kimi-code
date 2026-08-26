/**
 * Tests for `EditorKeyboardController` — editor-level key handling:
 * Ctrl+C / Ctrl+D double-tap exit, Esc dismissal + double-esc undo (incl.
 * the non-Esc-input window reset), plan toggle (incl. the v2 lazy-session
 * path), change clearing a pending exit, and insert-at-cursor paste
 * placeholders.
 *
 * The host surface is large (30+ methods); the mock supplies real `vi.fn`
 * spies for the methods each branch touches and casts the rest. The focus is
 * the observable branch outcome (host.stop / hideSessionPicker /
 * openUndoSelector / handlePlanToggle / ensureSession / editorDraft), not the
 * private compaction/stream internals.
 */

import { describe, expect, it, vi } from 'vitest'

import type { InputRenderable } from '@opentui/core'
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk'

import { EditorKeyboardController, type EditorKeyboardHost } from '@/tui2/controllers/editor-keyboard'
import { setEditorInput } from '@/tui2/components/editor/editor-input-ref'
import { getPasteRegistry } from '@/tui2/components/editor/paste-markers'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { ImageAttachmentStore } from '@/tui2/utils/image-attachment-store'

// The clipboard reader touches the real OS clipboard; replace it so the
// paste-image path is driven entirely by mocks.
const readClipboardMedia = vi.hoisted(() => vi.fn())
vi.mock('@/utils/clipboard/clipboard-image', () => ({
  ClipboardMediaError: class ClipboardMediaError extends Error {},
  readClipboardMedia,
}))

function make(
  overrides?: Partial<EditorKeyboardHost>,
  imageStore: Record<string, unknown> = {},
): {
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
      scroll: (): boolean => false,
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
  return {
    store,
    host,
    ctrl: new EditorKeyboardController(host, imageStore as unknown as ImageAttachmentStore),
  }
}

/** Flush the constructor's fire-and-forget history warm-up. */
const flushHistory = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Minimal stand-in for opentui's InputRenderable: a value plus a cursor
 * offset, with `insertText` splicing at the offset and advancing it (the
 * behaviour the real edit buffer exhibits).
 */
function makeFakeInput(initial = ''): InputRenderable & { moveCursorTo(offset: number): void } {
  const state = { text: initial, offset: initial.length }
  return {
    get value(): string {
      return state.text
    },
    insertText(text: string): void {
      state.text = state.text.slice(0, state.offset) + text + state.text.slice(state.offset)
      state.offset += text.length
    },
    moveCursorTo(offset: number): void {
      state.offset = offset
    },
  } as unknown as InputRenderable & { moveCursorTo(offset: number): void }
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

  it('Ctrl+B detaches only while a turn / shell command runs', () => {
    const { store, host, ctrl } = make()
    expect(ctrl.handleCtrlB()).toBe(false)
    expect(host.detachCurrentForegroundTask).not.toHaveBeenCalled()
    store.setState('streamingPhase', 'composing')
    expect(ctrl.handleCtrlB()).toBe(true)
    expect(host.detachCurrentForegroundTask).toHaveBeenCalledTimes(1)
  })

  describe('input history recall', () => {
    const ENTRIES = ['first prompt', '!ls -la', 'second prompt']

    async function makeWithHistory() {
      const made = make({ loadInputHistoryEntries: async () => ENTRIES })
      await flushHistory()
      return made
    }

    it('recalls the newest entry with ↑ on an empty draft, older with ↑ again', async () => {
      const { store, ctrl } = await makeWithHistory()
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('second prompt')
      // Landing on the shell entry mid-browse restores bash mode and strips
      // the `!` marker (v1 onRecall semantics).
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.inputMode).toBe('bash')
      expect(store.state.editorDraft).toBe('ls -la')
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('first prompt')
    })

    it('↓ steps back toward the newest entry, then restores the empty draft', async () => {
      const { store, ctrl } = await makeWithHistory()
      ctrl.handleUpArrowEmpty()
      ctrl.handleUpArrowEmpty()
      // first prompt → second prompt
      expect(ctrl.handleDownArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('second prompt')
      // past the newest entry: browse exits, draft returns to the saved value
      expect(ctrl.handleDownArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('')
    })

    it('bash mode recalls only !-prefixed entries and strips the marker', async () => {
      const { store, ctrl } = await makeWithHistory()
      store.setState('inputMode', 'bash')
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.inputMode).toBe('bash')
      expect(store.state.editorDraft).toBe('ls -la')
      // No further bash entries: ↑ is a no-op (not consumed).
      expect(ctrl.handleUpArrowEmpty()).toBe(false)
    })

    it('recalling a plain entry returns from bash mode to prompt mode', async () => {
      const { store, host, ctrl } = await makeWithHistory()
      ctrl.handleUpArrowEmpty() // 'second prompt'
      ctrl.handleUpArrowEmpty() // '!ls -la' → bash mode
      expect(store.state.inputMode).toBe('bash')
      expect(ctrl.handleUpArrowEmpty()).toBe(true) // 'first prompt'
      expect(store.state.inputMode).toBe('prompt')
      expect(store.state.editorDraft).toBe('first prompt')
      expect(host.handleInputModeChange).toHaveBeenCalledWith('prompt')
    })

    it('a manual edit ends the browse session', async () => {
      const { store, ctrl } = await makeWithHistory()
      ctrl.handleUpArrowEmpty()
      expect(store.state.editorDraft).toBe('second prompt')
      // The programmatic-recall echo keeps browsing; ↓ then restores the
      // pre-browse draft.
      ctrl.handleChange('second prompt')
      expect(ctrl.handleDownArrowEmpty()).toBe(true)
      // A real edit (different text than the recall echo) ends the browse.
      store.setState('editorDraft', 'second prompt!')
      ctrl.handleChange('second prompt!')
      // Browse ended: ↓ falls through (btw scroll owns it, mock says no).
      expect(ctrl.handleDownArrowEmpty()).toBe(false)
    })

    it('submits feed the recall cache with consecutive-dedup', async () => {
      const { store, ctrl } = await makeWithHistory()
      ctrl.handleSubmit('second prompt') // duplicate of the newest entry
      ctrl.handleSubmit('third prompt')
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('third prompt')
      expect(ctrl.handleUpArrowEmpty()).toBe(true)
      expect(store.state.editorDraft).toBe('second prompt')
    })

    it('submits expand paste markers before reaching the send path', () => {
      const { store, host, ctrl } = make({ loadInputHistoryEntries: async () => [] })
      const marker = getPasteRegistry(store).insert('line one\nline two')
      ctrl.handleSubmit(`note ${marker}`)
      expect(host.handleUserInput).toHaveBeenCalledTimes(1)
      expect((host.handleUserInput as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
        'note line one\nline two',
      )
    })
  })

  describe('paste markers on steer', () => {
    it('Ctrl+S expands markers in the steered draft text', () => {
      const { store, host, ctrl } = make({
        session: {} as Session,
        harness: {} as KimiHarness,
      })
      store.setState('streamingPhase', 'composing')
      store.setState('model', 'kimi')
      const marker = getPasteRegistry(store).insert('alpha\nbeta')
      store.setState('editorDraft', `check ${marker}`)
      ctrl.handleCtrlS()
      expect(host.steerMessage).toHaveBeenCalledTimes(1)
      const items = ((host.steerMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] ?? []) as Array<{ text?: string }>
      expect(items[0]?.text).toContain('alpha\nbeta')
      expect(items[0]?.text).not.toContain('[paste #')
      expect(store.state.editorDraft).toBe('')
    })
  })

  describe('autocomplete popup', () => {
    it('↑/↓ navigate the open popup instead of recalling history', async () => {
      const { store, ctrl } = make({ loadInputHistoryEntries: async () => ['old'] })
      await flushHistory()
      store.setState('editorAutocomplete', {
        items: [
          { value: 'model', label: 'model' },
          { value: 'mcp', label: 'mcp' },
        ],
        selectedIndex: 0,
        prefix: '/m',
      })
      ctrl.handleUpArrowEmpty() // clamped at the top
      expect(store.state.editorAutocomplete?.selectedIndex).toBe(0)
      ctrl.handleDownArrowEmpty()
      expect(store.state.editorAutocomplete?.selectedIndex).toBe(1)
    })

    it('accept applies the selected suggestion over the prefix tail', () => {
      const { store, ctrl } = make()
      store.setState('editorDraft', '/mod')
      store.setState('editorAutocomplete', {
        items: [{ value: 'model', label: 'model' }],
        selectedIndex: 0,
        prefix: '/mod',
      })
      expect(ctrl.acceptAutocomplete()).toBe(true)
      expect(store.state.editorDraft).toBe('/model ')
      expect(store.state.editorAutocomplete).toBeUndefined()
    })

    it('Esc closes the popup before other escape semantics run', () => {
      const { store, host, ctrl } = make()
      store.setState('editorAutocomplete', {
        items: [{ value: 'model', label: 'model' }],
        selectedIndex: 0,
        prefix: '/mod',
      })
      ctrl.handleEscape()
      expect(store.state.editorAutocomplete).toBeUndefined()
      // The double-Esc undo arm did not start — this Esc was consumed.
      ctrl.handleEscape()
      expect(host.openUndoSelector).not.toHaveBeenCalled()
    })
  })

  describe('paste marker registry', () => {
    it('marks multi-line / oversized pastes and expands them back', () => {
      const { store } = make()
      const registry = getPasteRegistry(store)
      const multi = registry.insert('a\nb\nc')
      expect(multi).toMatch(/^\[paste #1 \+3 lines\]$/)
      const huge = registry.insert('x'.repeat(1001))
      expect(huge).toMatch(/^\[paste #2 1001 chars\]$/)
      expect(registry.expand(`h ${multi} t`)).toBe('h a\nb\nc t')
      expect(registry.expand(huge)).toBe('x'.repeat(1001))
      // Unknown ids (draft text typed by hand) stay untouched.
      expect(registry.expand('[paste #99]')).toBe('[paste #99]')
    })
  })

  describe('/goal objective length hint', () => {
    it('warns through footerTransientHint while typing an over-long goal', () => {
      const { store, ctrl } = make()
      ctrl.handleChange(`/goal ${'x'.repeat(4001)}`)
      expect(store.state.footerTransientHint).toContain('too long')
      ctrl.handleChange('/goal short objective')
      expect(store.state.footerTransientHint).toBeNull()
    })

    it('does not warn in bash mode or for non-goal input', () => {
      const { store, ctrl } = make()
      store.setState('inputMode', 'bash')
      ctrl.handleChange(`/goal ${'x'.repeat(4001)}`)
      expect(store.state.footerTransientHint).toBeNull()
      ctrl.handleChange(`${'y'.repeat(4001)}`)
      expect(store.state.footerTransientHint).toBeNull()
    })
  })

  describe('double-Esc undo window', () => {
    it('a non-Esc input between two Esc resets the double-tap window', () => {
      const { host, ctrl } = make()
      ctrl.handleEscape()
      // Typing breaks the window (v1 onNonEscapeInput semantics)…
      ctrl.handleChange('x')
      // …so the second Esc arms a fresh window instead of opening undo.
      ctrl.handleEscape()
      expect(host.openUndoSelector).not.toHaveBeenCalled()
    })

    it('an arrow key between two Esc resets the window too', () => {
      const { host, ctrl } = make({ loadInputHistoryEntries: async () => [] })
      ctrl.handleEscape()
      // The ↑ itself is consumed as editor input even when nothing recalls.
      ctrl.handleUpArrowEmpty()
      ctrl.handleEscape()
      expect(host.openUndoSelector).not.toHaveBeenCalled()
    })

    it('after a reset the next two bare Esc presses open the undo selector', () => {
      const { host, ctrl } = make()
      ctrl.handleEscape()
      ctrl.handleChange('x') // resets
      ctrl.handleEscape() // re-arms a fresh window
      expect(host.openUndoSelector).not.toHaveBeenCalled()
      ctrl.handleEscape()
      expect(host.openUndoSelector).toHaveBeenCalledTimes(1)
    })
  })

  describe('insert-at-cursor paste placeholders', () => {
    const videoMedia = {
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'example.mp4',
      sourcePath: '/example/example.mp4',
    }

    it('inserts the placeholder at the live cursor, not the draft tail', async () => {
      const input = makeFakeInput('ab')
      input.moveCursorTo(1) // caret sits between `a` and `b`
      const imageStore = { addVideo: () => ({ placeholder: '[video #1]' }) }
      const { store, host, ctrl } = make({}, imageStore)
      store.setState('editorDraft', 'ab')
      setEditorInput(store, input)
      readClipboardMedia.mockResolvedValue(videoMedia)

      await expect(ctrl.handlePasteImage()).resolves.toBe(true)
      expect(store.state.editorDraft).toBe('a[video #1] b')
      expect(host.track).toHaveBeenCalledWith('shortcut_paste', { kind: 'video' })
    })

    it('appends at the tail when no input renderable is mounted', async () => {
      const imageStore = { addVideo: () => ({ placeholder: '[video #2]' }) }
      const { store, ctrl } = make({}, imageStore)
      store.setState('editorDraft', 'hi ')
      readClipboardMedia.mockResolvedValue(videoMedia)

      await expect(ctrl.handlePasteImage()).resolves.toBe(true)
      expect(store.state.editorDraft).toBe('hi [video #2] ')
    })
  })
})