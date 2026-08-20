/**
 * Tests for `SubagentActivityStore` — the tui2 per-agent activity store.
 *
 * The store is pure logic: it folds subagent `Event`s into a bounded,
 * per-agent record tree (steps → tool calls → args / live output / result)
 * that feeds the AgentActivityViewer. These tests pin the semantics a real
 * run depends on: step folding, text-tail retention, tool-call lifecycle
 * (delta → started → result), live progress tails, retention caps, terminal
 * state transitions, and cross-record eviction.
 *
 * No renderer or store is booted — the class under test is the real one.
 */

import { describe, expect, it } from 'vitest'

import type { Event } from '@moonshot-ai/kimi-code-sdk'

import {
  MAX_SUBAGENT_ACTIVITY_STEPS,
  SUBAGENT_ARG_STRING_MAX_CHARS,
  SUBAGENT_STEP_TEXT_TAIL_CHARS,
  SUBAGENT_TOOL_OUTPUT_MAX_CHARS,
} from '@/tui2/constant/rendering'
import {
  MAX_SUBAGENT_ACTIVITY_RECORDS,
  SubagentActivityStore,
  type SubagentActivitySpawn,
} from '@/tui2/controllers/subagent-activity-store'

const SPAWN: SubagentActivitySpawn = {
  agentId: 'agent-1',
  agentName: 'helper',
  parentToolCallId: 'call-parent',
  model: 'kimi-k2',
  effort: 'high',
}

function makeStore(): { store: SubagentActivityStore; spawn: SubagentActivitySpawn } {
  const store = new SubagentActivityStore()
  store.ensureRecord(SPAWN)
  return { store, spawn: SPAWN }
}

function stepStarted(agentId: string, step: number): Event {
  return { type: 'turn.step.started', agentId, step, model: 'kimi-k2' } as unknown as Event
}

function assistantDelta(agentId: string, delta: string): Event {
  return { type: 'assistant.delta', agentId, delta } as Event
}

function toolStarted(agentId: string, toolCallId: string, name: string, args: unknown): Event {
  return {
    type: 'tool.call.started',
    agentId,
    toolCallId,
    name,
    args,
  } as Event
}

function toolDelta(agentId: string, toolCallId: string, argumentsPart: string, name?: string): Event {
  return { type: 'tool.call.delta', agentId, toolCallId, argumentsPart, name } as Event
}

function toolResult(agentId: string, toolCallId: string, output: unknown, isError?: boolean): Event {
  return {
    type: 'tool.result',
    agentId,
    toolCallId,
    output,
    isError,
  } as Event
}

function progress(agentId: string, toolCallId: string, kind: 'stdout' | 'stderr', text: string): Event {
  return {
    type: 'tool.progress',
    agentId,
    toolCallId,
    update: { kind, text },
  } as Event
}

function retrying(agentId: string, nextAttempt: number, maxAttempts: number, errorName: string): Event {
  return {
    type: 'turn.step.retrying',
    agentId,
    nextAttempt,
    maxAttempts,
    errorName,
  } as Event
}

describe('SubagentActivityStore', () => {
  it('folds step started + assistant deltas into one step with a text tail', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(assistantDelta(spawn.agentId, 'Hello '))
    store.applyEvent(assistantDelta(spawn.agentId, 'world'))

    const record = store.get(spawn.agentId)!
    expect(record.steps).toHaveLength(1)
    expect(record.steps[0]!.step).toBe(0)
    expect(record.steps[0]!.textTail).toBe('Hello world')
    expect(record.totalSteps).toBe(1)
  })

  it('keeps only the trailing text window', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(assistantDelta(spawn.agentId, 'x'.repeat(SUBAGENT_STEP_TEXT_TAIL_CHARS + 50)))

    const record = store.get(spawn.agentId)!
    expect(record.steps[0]!.textTail.length).toBe(SUBAGENT_STEP_TEXT_TAIL_CHARS)
  })

  it('assembles a tool call from delta → started → result', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolDelta(spawn.agentId, 'call-1', '{"file":"a.ts','Bash'))
    store.applyEvent(toolStarted(spawn.agentId, 'call-1', 'Bash', { command: 'ls' }))
    store.applyEvent(toolResult(spawn.agentId, 'call-1', 'file list', false))

    const record = store.get(spawn.agentId)!
    const call = record.steps[0]!.toolCalls[0]!
    expect(call.name).toBe('Bash')
    expect(call.status).toBe('done')
    expect(call.args).toEqual({ command: 'ls' })
    expect(call.result?.output).toBe('file list')
    expect(call.result?.is_error).toBe(false)
    expect(call.durationMs).toBeTypeOf('number')
    expect(call.liveOutputTail).toBeUndefined()
  })

  it('caps long argument strings', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(
      toolStarted(spawn.agentId, 'call-1', 'Write', { content: 'y'.repeat(SUBAGENT_ARG_STRING_MAX_CHARS + 10) }),
    )

    const call = store.get(spawn.agentId)!.steps[0]!.toolCalls[0]!
    const content = call.args['content'] as string
    expect(content.length).toBeLessThanOrEqual(SUBAGENT_ARG_STRING_MAX_CHARS + 1)
  })

  it('marks an errored result and truncates oversized output', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolStarted(spawn.agentId, 'call-1', 'Bash', {}))
    store.applyEvent(toolResult(spawn.agentId, 'call-1', 'e'.repeat(SUBAGENT_TOOL_OUTPUT_MAX_CHARS + 100), true))

    const call = store.get(spawn.agentId)!.steps[0]!.toolCalls[0]!
    expect(call.status).toBe('error')
    expect(call.result?.is_error).toBe(true)
    expect(call.result?.output.length).toBeLessThanOrEqual(SUBAGENT_TOOL_OUTPUT_MAX_CHARS + 64)
    expect(call.result?.output).toContain('truncated')
  })

  it('tracks the last live stdout/stderr line while running', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolStarted(spawn.agentId, 'call-1', 'Bash', {}))
    store.applyEvent(progress(spawn.agentId, 'call-1', 'stdout', 'line one\nline two\n'))

    const call = store.get(spawn.agentId)!.steps[0]!.toolCalls[0]!
    expect(call.liveOutputTail).toBe('line two')
  })

  it('ignores non-stdout progress updates and empty text', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolStarted(spawn.agentId, 'call-1', 'Bash', {}))
    store.applyEvent({
      type: 'tool.progress',
      agentId: spawn.agentId,
      toolCallId: 'call-1',
      update: { kind: 'json', text: '{}' },
    } as unknown as Event)
    store.applyEvent(progress(spawn.agentId, 'call-1', 'stdout', '   '))

    const call = store.get(spawn.agentId)!.steps[0]!.toolCalls[0]!
    expect(call.liveOutputTail).toBeUndefined()
  })

  it('records retrying metadata on the current step', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(retrying(spawn.agentId, 2, 3, 'RateLimit'))

    const record = store.get(spawn.agentId)!
    expect(record.steps[0]!.retrying).toContain('2/3')
    expect(record.steps[0]!.retrying).toContain('RateLimit')
  })

  it('caps retained steps at MAX_SUBAGENT_ACTIVITY_STEPS', () => {
    const { store, spawn } = makeStore()
    for (let step = 0; step < MAX_SUBAGENT_ACTIVITY_STEPS + 5; step++) {
      store.applyEvent(stepStarted(spawn.agentId, step))
    }
    const record = store.get(spawn.agentId)!
    expect(record.steps.length).toBe(MAX_SUBAGENT_ACTIVITY_STEPS)
    // totalSteps keeps the monotonic count.
    expect(record.totalSteps).toBe(MAX_SUBAGENT_ACTIVITY_STEPS + 5)
    // The oldest steps were evicted, newest survive.
    expect(record.steps[0]!.step).toBe(5)
    expect(record.steps.at(-1)!.step).toBe(MAX_SUBAGENT_ACTIVITY_STEPS + 4)
  })

  it('completes a record and clears its streaming buffers', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolDelta(spawn.agentId, 'call-1', '{"a":'))
    store.markCompleted(spawn.agentId, 'done in 3s')

    const record = store.get(spawn.agentId)!
    expect(record.status).toBe('completed')
    expect(record.resultSummary).toBe('done in 3s')
  })

  it('fails a record with the error message', () => {
    const { store, spawn } = makeStore()
    store.markFailed(spawn.agentId, 'boom')
    const record = store.get(spawn.agentId)!
    expect(record.status).toBe('failed')
    expect(record.error).toBe('boom')
  })

  it('resumes a record under the same agentId, preserving steps', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.markCompleted(spawn.agentId, 'done')
    const before = store.get(spawn.agentId)!.version

    store.ensureRecord(spawn)
    const record = store.get(spawn.agentId)!
    expect(record.status).toBe('running')
    expect(record.resultSummary).toBeUndefined()
    expect(record.steps).toHaveLength(1)
    // The resume bumped the version so the viewer re-renders.
    expect(record.version).toBeGreaterThan(before)
  })

  it('evicts terminal records beyond the cross-record cap, keeping running ones', () => {
    const store = new SubagentActivityStore()
    for (let i = 0; i < MAX_SUBAGENT_ACTIVITY_RECORDS + 3; i++) {
      const id = `agent-${i}`
      store.ensureRecord({ agentId: id, agentName: id, parentToolCallId: '' })
    }
    // Mark the oldest records terminal so the next spawn can evict them;
    // running records are never evicted.
    store.markCompleted('agent-0', 'done')
    store.markCompleted('agent-1', 'done')
    store.markCompleted('agent-2', 'done')
    store.ensureRecord({ agentId: 'newest', agentName: 'newest', parentToolCallId: '' })

    // The three terminal records were evicted; the running ones and the
    // newest spawn survive (running records are never evicted, so the store
    // may sit one over the cap).
    expect(store.get('agent-0')).toBeUndefined()
    expect(store.get('agent-1')).toBeUndefined()
    expect(store.get('agent-2')).toBeUndefined()
    expect(store.get('newest')).toBeDefined()
    expect(store.agentIds().length).toBe(MAX_SUBAGENT_ACTIVITY_RECORDS + 1)
  })

  it('clear() drops every record and buffer', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.applyEvent(toolDelta(spawn.agentId, 'call-1', '{"a":'))
    store.clear()
    expect(store.agentIds()).toEqual([])
    expect(store.get(spawn.agentId)).toBeUndefined()
  })

  it('drop() removes a single agent record', () => {
    const { store, spawn } = makeStore()
    store.applyEvent(stepStarted(spawn.agentId, 0))
    store.drop(spawn.agentId)
    expect(store.get(spawn.agentId)).toBeUndefined()
  })

  it('synthesizes a record for events without a prior spawn', () => {
    const store = new SubagentActivityStore()
    store.applyEvent(stepStarted('mystery-agent', 0))
    store.applyEvent(assistantDelta('mystery-agent', 'hi'))
    const record = store.get('mystery-agent')!
    expect(record.agentName).toBe('mystery-agent')
    expect(record.steps[0]!.textTail).toBe('hi')
  })
})
