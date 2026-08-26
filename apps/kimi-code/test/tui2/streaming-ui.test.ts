/**
 * Tests for `StreamingUIController` — the tui2 streaming driver.
 *
 * The controller is pure logic: it accumulates deltas in draft buffers and
 * commits them to the response store in flush batches (no pi-tui
 * Containers). These tests pin the semantics a real terminal run depends
 * on: single transcript entries per stream, tool-call lifecycle, Agent/Read
 * grouping, flush throttling and turn finalization.
 *
 * The host is a fiducial mock (real `Tui2Store` + `vi.fn()` hooks); the
 * controller under test is the real class.
 */

import { describe, expect, it, vi } from 'vitest'

import { StreamingUIController, type StreamingUIHost } from '@/tui2/controllers/streaming-ui'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { QueuedMessage, ToolCallBlockData } from '@/tui2/types'

function createHarness(): {
  store: Tui2Store
  host: StreamingUIHost
  controller: StreamingUIController
} {
  const store = createTui2Store()
  const host: StreamingUIHost = {
    store,
    session: undefined,
    setAppState: (patch) => {
      // App-state slices are all top-level; a plain partial object merges
      // the changed keys into the store (SolidJS shallow-merge at root).
      store.setState(patch as never)
    },
    patchLivePane: (patch) => store.patch('livePane', patch),
    resetLivePane: () => store.patch('livePane', { mode: 'idle' }),
    updateActivityPane: vi.fn(),
    updateAgentPane: vi.fn(),
    updateDiffReviewPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: () => {
      throw new Error('no session in this mock')
    },
    deferUserMessages: false,
    shiftQueuedMessage: () => undefined,
    pushTranscriptEntry: (entry) =>
      store.setState('transcript', (entries) => [...entries, entry]),
    mergeCurrentTurnSteps: vi.fn(),
    mergeCompletedTurnAssistants: vi.fn(),
    write: vi.fn(),
  }
  const controller = new StreamingUIController(host)
  return { store, host, controller }
}

describe('StreamingUIController', () => {
  it('accumulates thinking deltas into a single transcript entry', () => {
    const { store, controller } = createHarness()

    controller.appendThinkingDelta('Re')
    controller.markThinkingDirty()
    controller.flushNow()
    controller.appendThinkingDelta('asoning through')
    controller.markThinkingDirty()
    controller.flushNow()

    const thinking = store.state.transcript.filter((e) => e.kind === 'thinking')
    expect(thinking.length).toBe(1)
    expect(thinking[0]?.content).toBe('Reasoning through')
  })

  it('skips an empty thinking buffered value without creating an entry', () => {
    const { store, controller } = createHarness()

    controller.markThinkingDirty()
    controller.flushNow()

    expect(store.state.transcript.filter((e) => e.kind === 'thinking').length).toBe(0)
  })

  it('streams assistant text as one entry and patches its content', () => {
    const { store, controller } = createHarness()

    controller.appendAssistantDelta('hello ')
    controller.markAssistantDirty()
    controller.flushNow()
    controller.appendAssistantDelta('world')
    controller.markAssistantDirty()
    controller.flushNow()

    const assistants = store.state.transcript.filter((e) => e.kind === 'assistant')
    expect(assistants.length).toBe(1)
    expect(assistants[0]?.content).toBe('hello world')
    // The still-streaming entry is flagged so views bound re-lexing to a tail.
    expect(assistants[0]?.streaming).toBe(true)

    controller.finalizeAssistantStream()
    expect(
      store.state.transcript.find((e) => e.kind === 'assistant')?.streaming,
    ).toBeUndefined()
  })

  it('registers a tool call, streams its arguments, and completes it with a result', () => {
    const { store, controller } = createHarness()

    const isNew = controller.registerToolCall({ id: 'tc1', name: 'Bash', args: { command: 'ls' } })
    expect(isNew).toBe(true)
    let entries = store.state.transcript.filter((e) => e.kind === 'tool_call')
    expect(entries.length).toBe(1)
    expect(entries[0]?.toolCallData?.name).toBe('Bash')

    controller.accumulateToolCallDelta('tc1', 'Bash', '{"command":"ls"}')
    controller.flushNow()
    expect(controller.getStreamingToolCallPreview('tc1')?.argumentsText).toBe('{"command":"ls"}')

    const result = controller.completeToolResult('tc1', {
      tool_call_id: 'tc1',
      output: 'file.txt',
      is_error: false,
    })
    expect(result?.name).toBe('Bash')

    entries = store.state.transcript.filter((e) => e.kind === 'tool_call')
    expect(entries[0]?.toolCallData?.result?.output).toBe('file.txt')
    expect(controller.getActiveToolCall('tc1')).toBeUndefined()
  })

  it('groups consecutive Agent calls in the same step under one groupKey', () => {
    const { store, controller } = createHarness()
    controller.setTurnId('turn')
    controller.setStep(0)

    controller.onToolCallStart({ id: 'a1', name: 'Agent', args: {} } as ToolCallBlockData)
    controller.onToolCallStart({ id: 'a2', name: 'Agent', args: {} } as ToolCallBlockData)

    const toolCalls = store.state.transcript.filter((e) => e.kind === 'tool_call')
    expect(toolCalls.length).toBe(2)
    expect(toolCalls[0]?.groupKey).toBe('agent:turn:0')
    expect(toolCalls[1]?.groupKey).toBe('agent:turn:0')
  })

  it('groups consecutive Read calls in the same step under their own groupKey', () => {
    const { store, controller } = createHarness()
    controller.setTurnId('turn')
    controller.setStep(0)

    controller.onToolCallStart({ id: 'r1', name: 'Read', args: {} } as ToolCallBlockData)
    controller.onToolCallStart({ id: 'r2', name: 'Read', args: {} } as ToolCallBlockData)

    const toolCalls = store.state.transcript.filter((e) => e.kind === 'tool_call')
    expect(toolCalls.length).toBe(2)
    expect(toolCalls[0]?.groupKey).toBe('read:turn:0')
    expect(toolCalls[1]?.groupKey).toBe('read:turn:0')
  })

  it('keeps a single Agent call ungrouped and separate from Read', () => {
    const { store, controller } = createHarness()
    controller.setTurnId('turn')
    controller.setStep(0)

    controller.onToolCallStart({ id: 'a1', name: 'Agent', args: {} } as ToolCallBlockData)
    controller.onToolCallStart({ id: 'r1', name: 'Read', args: {} } as ToolCallBlockData)

    const toolCalls = store.state.transcript.filter((e) => e.kind === 'tool_call')
    // A lone Agent stays solo (no groupKey); Read groups separately.
    expect(toolCalls[0]?.groupKey).toBeUndefined()
    expect(toolCalls[1]?.groupKey).toBeUndefined()
  })

  it('marks in-flight streamed tool calls as truncated at max_tokens', () => {
    const { store, controller } = createHarness()
    controller.setTurnId('t')
    controller.setStep(1)
    controller.registerToolCall({ id: 'tc', name: 'Bash', args: {}, step: 1, turnId: 't' })
    controller.accumulateToolCallDelta('tc', 'Bash', '{"a"')
    controller.flushNow()

    const count = controller.markStepTruncated('t', 1)
    expect(count).toBe(1)
    const entry = store.state.transcript.find((e) => e.kind === 'tool_call')
    expect(entry?.toolCallData?.truncated).toBe(true)
  })

  it('finalizes a composing turn and dispatches the dequeued message', () => {
    const { store, host, controller } = createHarness()
    const queued: QueuedMessage = { text: 'follow-up' }
    host.shiftQueuedMessage = () => queued

    store.setState('streamingPhase', 'composing')
    store.setState('notifications', { enabled: false, condition: 'unfocused' })

    let sent: QueuedMessage | undefined
    const sendQueued = vi.fn((item: QueuedMessage) => {
      sent = item
    })

    vi.useFakeTimers()
    try {
      controller.finalizeTurn(sendQueued)
      vi.advanceTimersByTime(0)
    } finally {
      vi.useRealTimers()
    }

    expect(store.state.streamingPhase).toBe('idle')
    expect(sent?.text).toBe('follow-up')
    expect(sendQueued).toHaveBeenCalledWith(queued)
  })

  it('flushes assistant+tool state and clears turn context after a clean turn', () => {
    const { store, controller } = createHarness()
    controller.setTurnId('clean')
    controller.setStep(0)
    controller.appendAssistantDelta('done')
    controller.markAssistantDirty()

    controller.flushNow()
    expect(controller.hasActiveTurn()).toBe(true)

    controller.finalizeAssistantStream()
    expect(store.state.transcript.some((e) => e.kind === 'assistant')).toBe(true)
  })
})