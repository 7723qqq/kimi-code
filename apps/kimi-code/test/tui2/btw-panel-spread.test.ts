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
  readonly storeState: { current: Record<string, unknown> }
  readonly session: Session
  readonly harness: KimiHarness
  /** Queue the events that the host routes into the panel via `routeEvent`.
   *  Used to observe the bus subscription if the controller subscribes. */
  readonly routedEvents: Event[]
}

function setupHarness(opts?: { sessionPrompt?: ReturnType<typeof vi.fn> }): Harness {
  const storeState: { current: Record<string, unknown> } = { current: {} }
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
  const bus = {
    subscribe: vi.fn((handler: (e: Event) => boolean) => {
      routedEvents.push = handler as never // not used; the controller calls handler directly via routeEvent
      return () => undefined
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
  return { controller, storeState, session, harness, routedEvents }
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
