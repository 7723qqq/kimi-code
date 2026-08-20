/**
 * Regression tests for `createBtwPanelController`'s partial-write paths.
 *
 * The streaming event handler used to write single-field patches through
 * SolidJS `createStore` setters, which **replace the entire `btwPanel`
 * slice** and silently wipe `active` / `running` / `thinking` / `agentId` /
 * etc. mid-stream. The controller now routes every partial write through
 * `patchBtwPanel`, which spreads the current slice. These tests pin the
 * behavior across the streaming deltas, scroll, and the busy notice.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk'

import { createBtwPanelController } from '@/tui2/controllers/btw-panel'
import type { BtwPanelHost } from '@/tui2/controllers/btw-panel'
import type { Tui2Store } from '@/tui2/state'

interface Harness {
  readonly controller: ReturnType<typeof createBtwPanelController>
  readonly host: BtwPanelHost
  readonly storeState: { current: Record<string, unknown> }
  readonly session: Session
  readonly harness: KimiHarness
  /** Queue the events that the host routes into the panel via `routeEvent`.
   *  Used to observe the bus subscription if the controller subscribes. */
  readonly routedEvents: Event[]
  /** The teardown returned by the mock bus subscription. */
  readonly busTeardown: ReturnType<typeof vi.fn>
}

function setupHarness(opts?: { sessionPrompt?: ReturnType<typeof vi.fn> }): Harness {
  // The real store always boots the `btwPanel` slice (closed); the controller
  // reads `state.btwPanel` unconditionally, so the mock mirrors that.
  const storeState: { current: Record<string, unknown> } = {
    current: {
      btwPanel: {
        active: false,
        agentId: '',
        answer: '',
        thinking: '',
        running: false,
        done: false,
        failed: null,
        transientNotice: null,
        scrollOffset: 0,
      },
    },
  }
  const setState = vi.fn((key: string, value: unknown) => {
    storeState.current = { ...storeState.current, [key]: value }
  })
  const store: Tui2Store = {
    get state() {
      return storeState.current as unknown as Tui2Store['state']
    },
    setState,
    patch(key: string, partial: unknown) {
      // Mirror the real impl: spread prev when it's an object, bootstrap
      // when undefined, skip on null / primitive.
      const slice = storeState.current[key]
      if (slice === null) return
      if (slice === undefined) {
        storeState.current = { ...storeState.current, [key]: partial }
        return
      }
      if (typeof slice === 'object') {
        storeState.current = {
          ...storeState.current,
          [key]: { ...(slice as object), ...(partial as object) },
        }
      }
    },
  } as unknown as Tui2Store

  const sessionPrompt = opts?.sessionPrompt ?? vi.fn(async () => undefined)
  const session = {
    prompt: sessionPrompt,
    cancel: vi.fn(async () => undefined),
  } as unknown as Session

  const harness = {
    withInteractiveAgent: vi.fn(async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn()),
  } as unknown as KimiHarness

  const routedEvents: Event[] = []
  const busTeardown = vi.fn(() => undefined)
  const bus = {
    subscribe: vi.fn((handler: (e: Event) => boolean) => {
      routedEvents.push = handler as never // not used; the controller calls handler directly via routeEvent
      return busTeardown
    }),
  }

  const host: BtwPanelHost = {
    store,
    bus: bus as unknown as BtwPanelHost['bus'],
    session,
    harness,
    showError: vi.fn(),
  }

  const controller = createBtwPanelController(host)
  return { controller, host, storeState, session, harness, routedEvents, busTeardown }
}

function panel(harness: Harness): Record<string, unknown> {
  return harness.storeState.current['btwPanel'] as Record<string, unknown>
}

describe('createBtwPanelController streaming accumulation', () => {
  it('open() initialises the slice in full', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hello')
    const p = panel(h)
    expect(p['active']).toBe(true)
    expect(p['agentId']).toBe('agent-1')
    expect(p['running']).toBe(true)
    expect(p['answer']).toBe('')
    expect(p['thinking']).toBe('')
    expect(p['done']).toBe(false)
    expect(p['failed']).toBeNull()
    expect(p['transientNotice']).toBeNull()
    expect(p['scrollOffset']).toBe(0)
  })

  it('assistant.delta accumulates into answer without wiping running / agentId / thinking', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')

    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'hello ' } as Event)
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'world' } as Event)

    const p = panel(h)
    expect(p['answer']).toBe('hello world')
    expect(p['active']).toBe(true)
    expect(p['agentId']).toBe('agent-1')
    expect(p['running']).toBe(true)
    expect(p['thinking']).toBe('')
  })

  it('thinking.delta accumulates into thinking without wiping answer', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')

    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'A1' } as Event)
    h.controller.routeEvent({ type: 'thinking.delta', agentId: 'agent-1', delta: 'T1 ' } as Event)
    h.controller.routeEvent({ type: 'thinking.delta', agentId: 'agent-1', delta: 'T2' } as Event)
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'A2' } as Event)

    const p = panel(h)
    expect(p['answer']).toBe('A1A2')
    expect(p['thinking']).toBe('T1 T2')
    expect(p['active']).toBe(true)
    expect(p['agentId']).toBe('agent-1')
    expect(p['running']).toBe(true)
  })

  it('turn.ended (completed) sets running=false / done=true without losing the accumulated answer / agentId', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'final' } as Event)
    h.controller.routeEvent({
      type: 'turn.ended',
      agentId: 'agent-1',
      reason: 'completed',
    } as Event)

    const p = panel(h)
    expect(p['running']).toBe(false)
    expect(p['done']).toBe(true)
    expect(p['failed']).toBeNull()
    expect(p['answer']).toBe('final')
    expect(p['agentId']).toBe('agent-1')
    expect(p['active']).toBe(true)
  })

  it('turn.ended (failed) sets running=false / failed=… without losing the partial answer / agentId', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'partial' } as Event)
    h.controller.routeEvent({
      type: 'turn.ended',
      agentId: 'agent-1',
      reason: 'failed',
      error: { code: 'provider.filtered', message: 'blocked' },
    } as Event)

    const p = panel(h)
    expect(p['running']).toBe(false)
    expect(p['done']).toBe(false)
    expect(p['failed']).toBeTruthy()
    expect(p['answer']).toBe('partial')
    expect(p['agentId']).toBe('agent-1')
  })

  it('hook.result appends formatted output to answer without wiping running / thinking', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'thinking.delta', agentId: 'agent-1', delta: 'T' } as Event)
    h.controller.routeEvent({
      type: 'hook.result',
      agentId: 'agent-1',
      hookName: 'PreToolUse',
      content: 'ok',
    } as unknown as Event)

    const p = panel(h)
    expect((p['answer'] as string).length).toBeGreaterThan(0)
    expect(p['thinking']).toBe('T')
    expect(p['running']).toBe(true)
    expect(p['agentId']).toBe('agent-1')
  })

  it('scroll() preserves active / running / answer while updating scrollOffset', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'X' } as Event)

    const ok = h.controller.scroll('up')
    expect(ok).toBe(true)

    const p = panel(h)
    expect(p['scrollOffset']).toBe(1)
    expect(p['active']).toBe(true)
    expect(p['running']).toBe(true)
    expect(p['answer']).toBe('X')
    expect(p['agentId']).toBe('agent-1')
  })

  it('sendUserInput while running sets transientNotice without wiping anything else', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'mid' } as Event)

    const handled = h.controller.sendUserInput('next')
    expect(handled).toBe(true)

    const p = panel(h)
    expect(p['transientNotice']).toBeTruthy()
    expect(p['active']).toBe(true)
    expect(p['agentId']).toBe('agent-1')
    expect(p['running']).toBe(true)
    expect(p['answer']).toBe('mid')
    expect(h.storeState.current['editorDraft']).toBe('next')
  })

  it('routeEvent ignores events for a different agentId', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-2', delta: 'X' } as Event)
    expect(panel(h)['answer']).toBe('')
  })

  it('clear() resets the slice in full', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'X' } as Event)
    h.controller.clear()

    const p = panel(h)
    expect(p['active']).toBe(false)
    expect(p['agentId']).toBe('')
    expect(p['answer']).toBe('')
    expect(p['thinking']).toBe('')
    expect(p['running']).toBe(false)
  })
})

/**
 * Behavioral coverage — the control-flow semantics beyond the spread fix:
 * idle submit, cancellation routing, no-session failure, turn-end status
 * mapping, and boundary return values.
 */
describe('createBtwPanelController behavior', () => {
  it('sendUserInput() while idle submits the prompt to the session', async () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'first')
    h.controller.routeEvent({ type: 'turn.ended', agentId: 'agent-1', reason: 'completed' } as Event)

    const handled = h.controller.sendUserInput('second')
    expect(handled).toBe(true)
    expect(h.session.prompt).toHaveBeenCalledWith('second')
  })

  it('sendUserInput() when the panel is closed returns false', () => {
    const h = setupHarness()
    expect(h.controller.sendUserInput('x')).toBe(false)
  })

  it('submitPrompt() with no session marks the panel failed', () => {
    const h = setupHarness()
    ;(h.host as { session: Session | undefined }).session = undefined

    h.controller.open('agent-1', 'hi')

    const p = panel(h)
    expect(p['running']).toBe(false)
    expect(p['failed']).toBeTruthy()
  })

  it('submitPrompt() surfaces a rejected session prompt as a failure', async () => {
    const h = setupHarness({ sessionPrompt: vi.fn(async () => {
      throw new Error('network down')
    }) })
    h.controller.open('agent-1', 'hi')

    await vi.waitFor(() => {
      expect(panel(h)['running']).toBe(false)
    })
    expect(String(panel(h)['failed'])).toContain('network down')
  })

  it('closeOrCancel() while running cancels the agent and resets', async () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')

    const handled = h.controller.closeOrCancel()
    expect(handled).toBe(true)
    expect(h.session.cancel).toHaveBeenCalled()

    const p = panel(h)
    expect(p['active']).toBe(false)
    expect(p['running']).toBe(false)
  })

  it('closeOrCancel() when the panel is closed returns false', () => {
    const h = setupHarness()
    expect(h.controller.closeOrCancel()).toBe(false)
  })

  it('cancelRunning() while running cancels and reports handled', async () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')

    expect(h.controller.cancelRunning()).toBe(true)
    expect(h.session.cancel).toHaveBeenCalled()
  })

  it('cancelRunning() when idle returns false', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'turn.ended', agentId: 'agent-1', reason: 'completed' } as Event)
    expect(h.controller.cancelRunning()).toBe(false)
  })

  it('scroll() down at offset 0 is a no-op that reports unhandled', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    expect(h.controller.scroll('down')).toBe(false)
    expect(panel(h)['scrollOffset']).toBe(0)
  })

  it('scroll() when the panel is closed returns false', () => {
    const h = setupHarness()
    expect(h.controller.scroll('up')).toBe(false)
  })

  it('routeEvent() when the panel is closed returns false', () => {
    const h = setupHarness()
    const handled = h.controller.routeEvent({ type: 'assistant.delta', agentId: 'agent-1', delta: 'x' } as Event)
    expect(handled).toBe(false)
  })

  it('turn.ended (cancelled) maps to the interrupted notice', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'turn.ended', agentId: 'agent-1', reason: 'cancelled' } as Event)
    const p = panel(h)
    expect(p['failed']).toBeTruthy()
    expect(p['running']).toBe(false)
  })

  it('turn.ended (blocked) maps to the blocked notice', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({ type: 'turn.ended', agentId: 'agent-1', reason: 'blocked' } as Event)
    expect(panel(h)['failed']).toBeTruthy()
  })

  it('turn.ended with an error formats the code into the failure', () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.routeEvent({
      type: 'turn.ended',
      agentId: 'agent-1',
      reason: 'failed',
      error: { code: 'api_error', message: 'boom' },
    } as Event)
    expect(String(panel(h)['failed'])).toContain('api_error')
  })

  it('clear() while running cancels the agent', async () => {
    const h = setupHarness()
    h.controller.open('agent-1', 'hi')
    h.controller.clear()
    expect(h.session.cancel).toHaveBeenCalled()
  })

  it('dispose() detaches the bus subscription', () => {
    const h = setupHarness()
    h.controller.dispose()
    expect(h.busTeardown).toHaveBeenCalled()
  })
})
