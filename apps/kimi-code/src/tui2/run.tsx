/** @jsxImportSource @opentui/solid */
/**
 * TUI2 KimiTUI run — wire the opentui renderer to the KimiTUI controller.
 *
 * Boots opentui, builds the response store, creates the KimiTUI
 * controller, mounts the MainShell view, and returns the booted triple.
 * The `KIMI_TUI2_BOOT_CHECK` env var makes the function exit shortly
 * after mount so CI can verify the wiring without a real terminal.
 *
 * The `Shell` exported below is the default top-level view: the base
 * keymap wired to a dispatch that forwards dialog results back to the
 * host (`host.applyDialogResult` / `host.cancelDialog`). Tests and
 * alternative entry points can swap the Shell for a custom view.
 *
 * Editor state follows the response store: the input renderable's
 * onChange writes `store.state.editorDraft` and the editor-keyboard
 * controller's `handleChange`; submit routes through
 * `editorKeyboard.handleSubmit` so history, image extraction, bash-mode
 * and slash-command dispatch all run on the real send path.
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import { createCliRenderer } from '@opentui/core'
import { render, useTerminalDimensions } from '@opentui/solid'
import { KeymapProvider, useBindings, useKeymap } from '@opentui/keymap/solid'
import { createEffect, onCleanup } from 'solid-js'

import { Tui2ProviderStack, useTui2Store } from './context'
import {
  buildBaseLayer,
  COMMANDS,
  createTui2Keymap,
  leaderCommand,
  type Tui2CommandHandlers,
  type Tui2Keymap,
} from './keymap'
import { LEADER_CHORDS } from './keybindings'
import type { Tui2Store } from './state'
import type { KeyEvent } from '@opentui/core'
import { showModelPicker } from './commands/config'
import { dispatchInput, type SlashCommandHost } from './commands/dispatch'
import { MainShell } from './components/main-shell'
import type { EditorKeyboardController } from './controllers/editor-keyboard'
import { KimiTUI } from './controllers/kimi-tui'
import type { DialogDispatch, DialogResult } from './dispatch'
import { printableChar } from './utils/printable-key'

import type { CliRenderer } from '@opentui/core'

export interface RunKimiTui2Options {
  readonly harness: ConstructorParameters<typeof KimiTUI>[0]
  readonly startupInput: ConstructorParameters<typeof KimiTUI>[1]
  /**
   * Called when the TUI shuts down. Receives the live host so the caller
   * (CLI shell) can read session/exit state without ordering the callback
   * after `runKimiTui2` resolves — in a real terminal `runKimiTui2` only
   * returns after the renderer is destroyed, which happens after exit.
   */
  readonly onExit?: (host: KimiTUI, exitCode?: number) => Promise<void>
  readonly exitForegroundTask?: (exitCode: number) => Promise<void>
}

export interface RunKimiTui2Result {
  readonly renderer: CliRenderer
  readonly store: Tui2Store
  readonly keymap: Tui2Keymap
  readonly host: KimiTUI
}

/**
 * Adapter from the host's `applyDialogResult` / `cancelDialog` methods
 * to the shell's `DialogDispatch` protocol. Fire-and-forget: dialog
 * callbacks return synchronously; any async work the host kicks off
 * (e.g. session switching, theme apply) is awaited inside the host.
 */
function hostToDispatch(host: KimiTUI): DialogDispatch {
  return {
    select: (result: DialogResult) => {
      void host.applyDialogResult(result)
    },
    cancel: (_kind) => {
      host.cancelDialog()
    },
  }
}

/**
 * The default Shell wires the base keymap to the host's editor-keyboard
 * controller and mounts the MainShell with a host-bound dispatch. Editor
 * text lives in `store.state.editorDraft`; Enter (or the keymap send
 * binding) triggers `handleSubmit`.
 */
export const Shell = (renderer: CliRenderer, host: KimiTUI) => () => {
  const store = useTui2Store()
  const dimensions = useTerminalDimensions()
  const dispatch = hostToDispatch(host)
  const editorKeyboard = host.editorKeyboard

  // Leader overlay: show the Ctrl-X hint while opentui is mid-sequence (the
  // first stroke was consumed as a chord prefix), hide it once the chord
  // resolves, mismatches, or times out. The keymap reports the in-flight
  // sequence through its `pendingSequence` event.
  const keymap = useKeymap()
  createEffect(() => {
    const offPending = keymap.on('pendingSequence', (sequence: readonly unknown[]) => {
      // A single pending stroke whose name is 'x' with ctrl means the leader
      // is armed; any other pending sequence (or none) means it is not.
      const first = sequence[0] as
        | { readonly stroke?: { readonly name?: string; readonly ctrl?: boolean } }
        | undefined;
      const armed = first !== undefined && first.stroke?.name === 'x' && first.stroke.ctrl === true;
      if (armed) {
        host.showLeaderOverlay();
      } else {
        host.hideLeaderOverlay();
      }
    });
    onCleanup(offPending);
  });

  const submitDraft = (): void => {
    const v = store.state.editorDraft
    if (v.trim().length === 0) return
    store.setState('editorDraft', '')
    editorKeyboard.handleSubmit(v)
  }

  const handlers: Tui2CommandHandlers = {
    'tui2.send': submitDraft,
    'tui2.cancel': () => editorKeyboard.handleEscape(),
    'tui2.cancelStream': () => editorKeyboard.handleCtrlC(),
    'tui2.exit': () => editorKeyboard.handleCtrlD(),
    'tui2.editor.focus': () => {
      // opentui keeps the input focused while no dialog is open; nothing to
      // do here (kept so the command catalog is complete).
    },
    'tui2.model.switch': () => {
      // Full tabbed model picker via the editor-replacement slot.
      showModelPicker(host as unknown as SlashCommandHost)
    },
    'tui2.editor.external': () => editorKeyboard.handleOpenExternalEditor(),
    'tui2.tool.output': () => editorKeyboard.handleToggleToolExpand(),
    // Ctrl+S: steer — splice the queued messages + the editor draft into the
    // running turn (the drain-oldest behaviour moved to queue completion).
    'tui2.queue.send': () => editorKeyboard.handleCtrlS(),
    // Alt+V (Windows) / Ctrl+V elsewhere: paste a clipboard image / video.
    [COMMANDS.pasteImage]: () => {
      void editorKeyboard.handlePasteImage()
    },
    // Ctrl+B: detach the current foreground task.
    [COMMANDS.detachBackground]: () => {
      editorKeyboard.handleCtrlB()
    },
    'tui2.todo.expand': () => editorKeyboard.handleToggleTodoExpand(),
    'tui2.sessions': () => void host.showSessionPicker(),
    'tui2.session.new': () => void host.showSessionPicker(),
    'tui2.help': () => host.showHelpPanel(),
    'tui2.which-key': () => editorKeyboard.handleShowWhichKey(),
    'tui2.plan.toggle': () => editorKeyboard.dispatchWhichKeyAction('plan-mode'),
    // Leader chords (Ctrl+X <key>): forward straight into the editor-keyboard
    // leader dispatch — the same actions the which-key palette executes.
    ...Object.fromEntries(
      LEADER_CHORDS.map(({ action }) => [
        leaderCommand(action),
        () => editorKeyboard.handleLeaderAction(action),
      ]),
    ),
  }
  useBindings(() => buildBaseLayer(handlers))

  // Editor-scoped key routing (see createEditorKeyInterceptor below).
  const offEditorKeyIntercept = keymap.intercept(
    'key',
    createEditorKeyInterceptor({ store, editorKeyboard }),
  )
  onCleanup(offEditorKeyIntercept)

  return (
    <MainShell
      dispatch={dispatch}
      width={dimensions().width}
      height={dimensions().height}
      activityMode={store.state.activityMode === 'idle' ? 'hidden' : store.state.activityMode}
      activityTip={store.state.activityTip}
      activityDetail={store.state.activityDetail}
      onEditorChange={(text) => {
        store.setState('editorDraft', text)
        editorKeyboard.handleChange(text)
      }}
      onEditorSubmit={(text) => {
        // The input renderable's own submit path (e.g. mouse click on
        // Enter) — route through the same send path as the keymap.
        if (text.trim().length === 0) return
        store.setState('editorDraft', '')
        editorKeyboard.handleSubmit(text)
      }}
      onModelClick={() => {
        showModelPicker(host as unknown as SlashCommandHost)
      }}
      onModeClick={() => {
        dispatchInput(host as unknown as SlashCommandHost, '/permission')
      }}
      onTasksClick={() => {
        void host.tasksBrowserController.show()
      }}
      onGoalClick={() => {
        dispatchInput(host as unknown as SlashCommandHost, '/goal')
      }}
    />
  )
}

/**
 * Translate an opentui KeyEvent into the raw-data vocabulary
 * `TranscriptNavController.handleKey` understands (key names plus legacy
 * byte literals); printables decode through printableChar so Kitty CSI-u
 * sequences map back to plain characters.
 */
function transcriptNavData(key: KeyEvent): string {
  switch (key.name) {
    case 'escape':
      return 'escape'
    case 'return':
    case 'enter':
      return 'enter'
    case 'up':
      return 'up'
    case 'down':
      return 'down'
    default:
      return printableChar(
        key.sequence !== undefined && key.sequence.length > 0 ? key.sequence : (key.name ?? ''),
      )
  }
}

/** Whether the main editor owns keyboard focus (no dialog / external editor). */
function isEditorFocusState(store: Tui2Store): boolean {
  return (
    store.state.activeDialog === null &&
    store.state.editorReplacement === undefined &&
    !store.state.externalEditorRunning
  )
}

/**
 * Key-intercept handler for editor-scoped routing: armed only while the main
 * editor owns the input focus (no dialog / editor replacement / external
 * editor). While transcript navigation is active it owns
 * j/k/↑/↓/Enter/Esc first; otherwise ↑/↓ drive autocomplete navigation +
 * input-history recall, and Enter/Tab select a highlighted suggestion
 * instead of reaching the editor buffer (consumed only when a suggestion
 * was actually applied). The single-line input has no ↑/↓ cursor semantics,
 * so consuming them while the editor is focused loses nothing.
 */
export function createEditorKeyInterceptor(deps: {
  readonly store: Tui2Store
  readonly editorKeyboard: Pick<
    EditorKeyboardController,
    | 'handleUpArrowEmpty'
    | 'handleDownArrowEmpty'
    | 'acceptAutocomplete'
    | 'handleTranscriptNavKey'
  >
}): (ctx: { event: KeyEvent; consume: () => void }) => void {
  return (ctx) => {
    if (!isEditorFocusState(deps.store)) return
    const key = ctx.event
    if (key.ctrl || key.meta || key.shift || key.super === true) return
    // Navigation mode eats its keys (consuming so history recall and the
    // editor buffer never see them); unconsumed keys keep typing normally.
    if (deps.store.state.transcriptNav.active) {
      if (deps.editorKeyboard.handleTranscriptNavKey(transcriptNavData(key))) {
        ctx.consume()
      }
      return
    }
    switch (key.name) {
      case 'up':
        deps.editorKeyboard.handleUpArrowEmpty()
        ctx.consume()
        return
      case 'down':
        deps.editorKeyboard.handleDownArrowEmpty()
        ctx.consume()
        return
      case 'tab':
        if (
          deps.store.state.editorAutocomplete !== undefined &&
          deps.editorKeyboard.acceptAutocomplete()
        ) {
          ctx.consume()
        }
        return
      case 'return':
      case 'enter': {
        const ac = deps.store.state.editorAutocomplete
        if (ac !== undefined) {
          const draft = deps.store.state.editorDraft.trim()
          const isCompleteCommand =
            draft.includes(' ') ||
            ac.items.some((item) => item.value === draft || `/${item.value}` === draft)
          if (!isCompleteCommand) {
            if (deps.editorKeyboard.acceptAutocomplete()) {
              ctx.consume()
            }
          }
        }
        return
      }
    }
  }
}

export async function runKimiTui2(options: RunKimiTui2Options): Promise<RunKimiTui2Result> {
  const renderer = await createCliRenderer({ screenMode: 'main-screen', exitOnCtrlC: false })
  const keymap = createTui2Keymap(renderer)

  // Tui2Terminal adapter — opentui owns the terminal directly, the
  // controller only needs write / setTitle / setProgress to keep its
  // existing surface.
  const terminal = {
    write: (data: string) => process.stdout.write(data),
    setTitle: (title: string) => renderer.setTerminalTitle(title),
    setProgress: (_active: boolean) => {
      /* opentui has no progress indicator yet */
    },
  }

  const host = new KimiTUI(options.harness, options.startupInput, terminal)
  host.exitForegroundTask = options.exitForegroundTask

  let resolveDone!: (result: RunKimiTui2Result) => void
  const donePromise = new Promise<RunKimiTui2Result>((resolve) => {
    resolveDone = resolve
  })

  const onExit = options.onExit
  host.onExit = async (exitCode?: number) => {
    try {
      if (onExit !== undefined) {
        await onExit(host, exitCode)
      }
    } finally {
      try {
        renderer.destroy()
      } catch {
        /* ignore */
      }
      resolveDone({ renderer, store: host.store, keymap, host })
    }
  }

  const ShellView = Shell(renderer, host)
  await render(
    () => (
      <KeymapProvider keymap={keymap}>
        {/* The store provider must wrap every consumer (including the Shell's
            own useTui2Store()); mounting it inside the Shell would leave the
            store out of scope for the Shell function body itself. */}
        <Tui2ProviderStack store={host.store}>
          <ShellView />
        </Tui2ProviderStack>
      </KeymapProvider>
    ),
    renderer,
  )

  const startPromise = host.start()
  if (process.env['KIMI_TUI2_BOOT_CHECK'] === '1') {
    // Boot-check must tear down more than the renderer: the harness handles
    // opened by start() would otherwise keep the process alive after the
    // marker is written, hanging CI-style smoke runs.
    void startPromise.catch(() => undefined)
    setTimeout(() => {
      try {
        renderer.destroy()
      } catch {
        /* ignore */
      }
      process.stdout.write('TUI2_ENTRY_BOOT_OK\n')
      void options.harness.close().catch(() => undefined)
      resolveDone({ renderer, store: host.store, keymap, host })
    }, 300)
  } else {
    // Kick off the host's start in parallel with rendering.
    void startPromise.catch((err) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`\n[tui2 startup error]\n${msg}\n`)
      void host.stop(1)
    })
  }

  return donePromise
}
