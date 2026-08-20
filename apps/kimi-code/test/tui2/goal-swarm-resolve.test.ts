/**
 * Test for the goal/swarm undo resolve functions.
 *
 * `pickGoalStartChoice` / `pickSwarmStartPermission` / `pickUndoChoice`
 * must read the saved context from the tui2 store and forward to the
 * real resolve function (which switches permission + starts the
 * underlying command). This test pins the contract via a host stub
 * that records every call.
 */

import { describe, expect, it, vi } from 'vitest'

import { resolveGoalStartPermissionChoice } from '@/tui2/commands/goal'
import { resolveSwarmStartPermissionChoice } from '@/tui2/commands/swarm'
import { resolveUndoSelectorChoice } from '@/tui2/commands/undo'

interface MockHost {
  store: {
    setState: (k: string, v: unknown) => void
    state: Record<string, unknown>
  }
  state: {
    appState: {
      model: string
      permissionMode: string
      swarmMode: boolean
      transcript: unknown[]
    }
    transcriptEntries: unknown[]
  }
  restoreEditor: () => void
  restoreInputText: (text: string) => void
  showStatus: (text: string) => void
  showError: (text: string) => void
  requireSession: () => { setPermission: (m: string) => Promise<void> } | undefined
  session?: { setPermission: (m: string) => Promise<void>; undoHistory: (n: number) => Promise<void> }
  sendNormalUserInput: (text: string) => Promise<void>
  setAppState: (patch: Record<string, unknown>) => void
  appendTranscriptEntry: (entry: unknown) => void
  setSwarmMode: (enabled: boolean, trigger: 'manual' | 'task') => Promise<boolean>
}

function makeHost(overrides: Partial<MockHost> = {}): MockHost & { calls: string[]; setPermission: ReturnType<typeof vi.fn>; undoHistory: ReturnType<typeof vi.fn> } {
  const calls: string[] = []
  const setPermission = vi.fn(async (_mode: string) => undefined)
  const undoHistory = vi.fn(async (_n: number) => undefined)
  const host: MockHost & { calls: string[]; setPermission: ReturnType<typeof vi.fn>; undoHistory: ReturnType<typeof vi.fn> } = {
    calls,
    store: {
      setState: (k, v) => {
        (host.store.state as Record<string, unknown>)[k] = v
      },
      state: {},
    },
    state: {
      appState: {
        model: 'test-model',
        permissionMode: 'manual',
        swarmMode: false,
        transcript: [],
      },
      transcriptEntries: [],
    },
    restoreEditor: () => calls.push('restoreEditor'),
    restoreInputText: (t) => calls.push(`restoreInputText:${t}`),
    showStatus: (t) => calls.push(`showStatus:${t}`),
    showError: (t) => calls.push(`showError:${t}`),
    requireSession: () => host.session,
    session: {
      setPermission: (mode: string) => {
        calls.push(`session.setPermission:${mode}`)
        return setPermission(mode)
      },
      undoHistory: (n: number) => {
        calls.push(`session.undoHistory:${n}`)
        return undoHistory(n)
      },
    },
    sendNormalUserInput: (t) => {
      calls.push(`sendNormalUserInput:${t}`)
      return Promise.resolve()
    },
    setAppState: (p) => calls.push(`setAppState:${JSON.stringify(p)}`),
    appendTranscriptEntry: () => calls.push('appendTranscriptEntry'),
    setSwarmMode: () => Promise.resolve(true),
    setPermission,
    undoHistory,
    ...overrides,
  }
  return host
}

describe('tui2 goal/swarm/undo resolve flow', () => {
  it('resolveGoalStartPermissionChoice applies the chosen permission and starts the goal', async () => {
    const host = makeHost()
    host.store.state['goalStartContext'] = {
      parsed: { objective: 'write tests', replace: false },
      rawArgs: 'write tests',
    }
    await resolveGoalStartPermissionChoice(
      host as never,
      'auto',
    )
    // The chosen permission is set on the live session.
    expect(host.calls).toContain('restoreEditor')
    expect(host.setPermission).toHaveBeenCalledWith('auto')
  })

  it('resolveGoalStartPermissionChoice with cancel restores the command text', async () => {
    const host = makeHost()
    host.store.state['goalStartContext'] = {
      parsed: { objective: 'do thing' },
      rawArgs: 'do thing',
    }
    await resolveGoalStartPermissionChoice(host as never, 'cancel')
    expect(host.calls).toContain('restoreInputText:/goal do thing')
    // setPermission is NOT called when the user cancels.
    expect(host.setPermission).not.toHaveBeenCalled()
  })

  it('resolveSwarmStartPermissionChoice applies the chosen permission', async () => {
    const host = makeHost()
    host.store.state['swarmStartContext'] = { prompt: '/swarm ship it' }
    await resolveSwarmStartPermissionChoice(host as never, 'auto')
    expect(host.setPermission).toHaveBeenCalledWith('auto')
  })

  it('resolveUndoSelectorChoice dismisses the dialog before deciding what to do', async () => {
    const host = makeHost()
    host.store.state['undoChoices'] = [
      { id: 'undo:3', count: 3, input: 'retry', label: 'undo 3' },
    ]
    // resolveUndoSelectorChoice is sync up to the fire-and-forget
    // undoByCount promise; the dialog is dismissed synchronously here.
    resolveUndoSelectorChoice(host as never, {
      count: 3,
      input: 'retry',
    })
    // The dialog is dismissed before the undo runs. With an empty
    // transcript the undo call short-circuits, but the dispatch path
    // (activeDialog := null) still completes — that's what we test here.
    expect(host.store.state['activeDialog']).toBeNull()
    // Flush the fire-and-forget undoByCount microtask so the assertion
    // below doesn't race with it.
    await Promise.resolve()
  })

  it('resolveUndoSelectorChoice with null restores the editor without undoing', async () => {
    const host = makeHost()
    host.store.state['undoChoices'] = [
      { id: 'undo:2', count: 2, input: 'x', label: 'undo 2' },
    ]
    resolveUndoSelectorChoice(host as never, null)
    expect(host.calls).toContain('restoreEditor')
    expect(host.undoHistory).not.toHaveBeenCalled()
  })
})
