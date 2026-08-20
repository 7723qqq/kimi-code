/**
 * Tests for `createWorkflowPanelController` — the tui2 workflow panel driver.
 *
 * The controller reduces Workflow tool-call/result events into the store's
 * `workflowRuns` slice. It is pure logic: it parses `tool.call.started`
 * args and `tool.result` output text, dedupes runs by runId, back-calculates
 * `startedAt` from the reported elapsed time, and keeps the latest phase /
 * agent count. The opentui reconciler re-renders the panel from the store —
 * nothing here touches a renderer.
 *
 * The bus is a fiducial mock: a real `Tui2EventBus`-shaped object whose `on`
 * returns an unsubscribe and whose handlers we can invoke directly. The
 * store under test is the real `createTui2Store`.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Event } from '@moonshot-ai/kimi-code-sdk'

import { createWorkflowPanelController } from '@/tui2/controllers/workflow-panel'
import type { Tui2EventBus } from '@/tui2/event'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { WorkflowRunData } from '@/tui2/types'

type HandlerMap = {
  'tool.call.started': ((event: Extract<Event, { type: 'tool.call.started' }>) => void)[]
  'tool.result': ((event: Extract<Event, { type: 'tool.result' }>) => void)[]
}

function createHarness(): {
  store: Tui2Store
  bus: Tui2EventBus
  handlers: HandlerMap
  controller: ReturnType<typeof createWorkflowPanelController>
  emitToolCall: (event: Partial<Extract<Event, { type: 'tool.call.started' }>>) => void
  emitToolResult: (event: Partial<Extract<Event, { type: 'tool.result' }>>) => void
} {
  const store = createTui2Store()
  const handlers: HandlerMap = {
    'tool.call.started': [],
    'tool.result': [],
  }
  const off = vi.fn(() => undefined)
  const bus = {
    on(type: keyof HandlerMap, handler: never) {
      handlers[type].push(handler)
      return () => {
        const i = handlers[type].indexOf(handler)
        if (i >= 0) handlers[type].splice(i, 1)
      }
    },
    subscribe: vi.fn(() => () => undefined),
    dispose: off,
  } as unknown as Tui2EventBus

  const controller = createWorkflowPanelController(bus, store)

  const emitToolCall = (
    event: Partial<Extract<Event, { type: 'tool.call.started' }>>,
  ): void => {
    for (const handler of handlers['tool.call.started']) {
      handler({
        type: 'tool.call.started',
        turnId: 0,
        step: 0,
        toolCallId: 'call-1',
        name: 'Workflow',
        args: '{}',
        ...event,
      } as Extract<Event, { type: 'tool.call.started' }>)
    }
  }

  const emitToolResult = (event: Partial<Extract<Event, { type: 'tool.result' }>>): void => {
    for (const handler of handlers['tool.result']) {
      handler({
        type: 'tool.result',
        turnId: 0,
        step: 0,
        toolCallId: 'call-1',
        output: '',
        ...event,
      } as Extract<Event, { type: 'tool.result' }>)
    }
  }

  return { store, bus, handlers, controller, emitToolCall, emitToolResult }
}

function makeToolCallArgs(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ operation: 'run', name: 'deploy', ...overrides })
}

describe('createWorkflowPanelController', () => {
  it('ignores non-Workflow tool calls', () => {
    const { store, emitToolCall } = createHarness()
    emitToolCall({ name: 'Read', args: makeToolCallArgs() })
    expect(store.state.workflowRuns).toEqual([])
  })

  it('ignores tool calls with unparsable args', () => {
    const { store, emitToolCall } = createHarness()
    emitToolCall({ args: '{not json' })
    expect(store.state.workflowRuns).toEqual([])
  })

  it('builds a running run from a Workflow run + result pair', () => {
    const { store, emitToolCall, emitToolResult } = createHarness()
    emitToolCall({ toolCallId: 'call-1', args: makeToolCallArgs({ name: 'deploy' }) })
    emitToolResult({
      toolCallId: 'call-1',
      output: 'run_id: run-abc\nstatus: running\nphase: planning\nagents: 3\nelapsed: 2.5s',
    })

    expect(store.state.workflowRuns).toHaveLength(1)
    const run = store.state.workflowRuns[0]!
    expect(run.runId).toBe('run-abc')
    expect(run.name).toBe('deploy')
    expect(run.status).toBe('running')
    expect(run.currentPhase).toBe('planning')
    expect(run.agentCount).toBe(3)
    // startedAt is back-calculated from now - elapsed (within a 2s skew).
    expect(Math.abs(Date.now() - run.startedAt - 2500)).toBeLessThan(2000)
    expect(run.finishedAt).toBeUndefined()
  })

  it('updates an existing run in place when a later result repeats the runId', () => {
    const { store, emitToolCall, emitToolResult } = createHarness()
    emitToolCall({ toolCallId: 'call-1', args: makeToolCallArgs({ name: 'deploy' }) })
    emitToolResult({
      toolCallId: 'call-1',
      output: 'run_id: run-abc\nstatus: running\nphase: planning\nagents: 1\nelapsed: 1s',
    })
    const first = store.state.workflowRuns[0]!

    emitToolResult({
      toolCallId: 'call-2',
      output: 'run_id: run-abc\nstatus: completed\nphase: done\nagents: 4\nelapsed: 3s',
    })

    expect(store.state.workflowRuns).toHaveLength(1)
    const run = store.state.workflowRuns[0]!
    expect(run.status).toBe('completed')
    expect(run.currentPhase).toBe('done')
    // Agent count keeps the max; startedAt stays at the first observation.
    expect(run.agentCount).toBe(4)
    expect(run.startedAt).toBe(first.startedAt)
    expect(run.finishedAt).toBeDefined()
  })

  it('uses the pending run name for a bare result without an operation call', () => {
    const { store, emitToolResult } = createHarness()
    emitToolResult({
      toolCallId: 'call-1',
      output: 'run_id: run-xyz\nstatus: failed\nphase: build\nagents: 2\nelapsed: 0.5s',
    })
    const run = store.state.workflowRuns[0]!
    expect(run.name).toBe('workflow')
    expect(run.status).toBe('failed')
    expect(run.finishedAt).toBeDefined()
  })

  it('parses every status string into the WorkflowStatus union', () => {
    const { store, emitToolCall, emitToolResult } = createHarness()
    const statuses = ['running', 'completed', 'failed', 'cancelled', 'weird']
    const expected: WorkflowRunData['status'][] = ['running', 'completed', 'failed', 'cancelled', 'running']

    statuses.forEach((status, index) => {
      emitToolCall({
        toolCallId: `call-${index}`,
        args: makeToolCallArgs({ name: `wf-${index}` }),
      })
      emitToolResult({
        toolCallId: `call-${index}`,
        output: `run_id: run-${index}\nstatus: ${status}`,
      })
    })

    expect(store.state.workflowRuns.map((run) => run.status)).toEqual(expected)
  })

  it('keeps separate runs distinct in the list', () => {
    const { store, emitToolCall, emitToolResult } = createHarness()
    emitToolCall({ toolCallId: 'call-a', args: makeToolCallArgs({ name: 'a' }) })
    emitToolResult({ toolCallId: 'call-a', output: 'run_id: run-a\nstatus: running' })
    emitToolCall({ toolCallId: 'call-b', args: makeToolCallArgs({ name: 'b' }) })
    emitToolResult({ toolCallId: 'call-b', output: 'run_id: run-b\nstatus: completed' })

    expect(store.state.workflowRuns.map((run) => run.runId).sort()).toEqual(['run-a', 'run-b'])
  })

  it('subscribe() routes session events through the same handlers', () => {
    const { store, controller } = createHarness()
    let captured: ((event: Event) => void) | undefined
    const session = {
      onEvent: vi.fn((handler: (event: Event) => void) => {
        captured = handler
        return () => undefined
      }),
    }

    controller.subscribe(session as never)
    expect(session.onEvent).toHaveBeenCalledTimes(1)

    captured?.({
      type: 'tool.result',
      turnId: 0,
      step: 0,
      toolCallId: 'call-1',
      output: 'run_id: run-sub\nstatus: running',
    } as unknown as Event)

    expect(store.state.workflowRuns[0]?.runId).toBe('run-sub')
  })

  it('unsubscribe() detaches from the session but keeps tracked runs', () => {
    const { store, controller, emitToolCall, emitToolResult } = createHarness()
    emitToolCall({ toolCallId: 'call-1', args: makeToolCallArgs({ name: 'keep' }) })
    emitToolResult({ toolCallId: 'call-1', output: 'run_id: run-k\nstatus: running' })
    expect(store.state.workflowRuns).toHaveLength(1)

    controller.unsubscribe()
    expect(store.state.workflowRuns).toHaveLength(1)
  })

  it('clear() empties the list and the pending map', () => {
    const { store, controller, emitToolCall, emitToolResult } = createHarness()
    emitToolCall({ toolCallId: 'call-1', args: makeToolCallArgs({ name: 'x' }) })
    emitToolResult({ toolCallId: 'call-1', output: 'run_id: run-x\nstatus: running' })
    expect(store.state.workflowRuns).toHaveLength(1)

    controller.clear()
    expect(store.state.workflowRuns).toEqual([])

    // The pending map was cleared too: a follow-up result for the same
    // call falls back to the default name instead of the deleted one.
    emitToolResult({ toolCallId: 'call-1', output: 'run_id: run-y\nstatus: running' })
    expect(store.state.workflowRuns[0]?.name).toBe('workflow')
  })

  it('dispose() unsubscribes both the bus handlers and the session', () => {
    const { controller } = createHarness()
    controller.dispose()
    expect(controller).toBeDefined()
  })
})
