/**
 * Tests for `SubAgentEventHandler` — the tui2 child-agent lifecycle +
 * activity router.
 *
 * The handler is the bridge between raw `subagent.*` / child-agent events and
 * the tui2 store: it remembers spawns, activates/patches the parent tool-call
 * entry (via `streamingUI`), tees every child event into the activity store,
 * publishes swarm progress into `agentSwarmData`, and transcribes background
 * agent lifecycle into status entries.
 *
 * The host is a fiducial mock: a real `Tui2Store`, a mock `streamingUI` that
 * manages the tool-component map + transcript entries, and a `routeEvent`
 * that never swallows events so the child paths are exercised. The handler
 * under test is the real class.
 */

import { describe, expect, it, vi } from 'vitest'

import type { BackgroundTaskInfo, Event } from '@moonshot-ai/kimi-code-sdk'

import { SubAgentEventHandler, type SubagentLifecycleEvent } from '@/tui2/controllers/subagent-event-handler'
import type { SessionEventHost } from '@/tui2/controllers/session-event-handler'
import type { StreamingUIController } from '@/tui2/controllers/streaming-ui'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { ToolCallBlockData, TranscriptEntry } from '@/tui2/types'

const MAIN_AGENT_ID = 'main'

type SpawnedEvent = Extract<Event, { type: 'subagent.spawned' }>

interface Harness {
  readonly handler: SubAgentEventHandler
  readonly store: Tui2Store
  readonly streamingUI: {
    getToolComponent: ReturnType<typeof vi.fn>
    getActiveToolCall: ReturnType<typeof vi.fn>
    onToolCallStart: ReturnType<typeof vi.fn>
    getTurnContext: ReturnType<typeof vi.fn>
    finalizeLiveTextBuffers: ReturnType<typeof vi.fn>
    removeToolComponentIfInactive: ReturnType<typeof vi.fn>
    applyBackgroundTaskTerminalStatus: ReturnType<typeof vi.fn>
  }
  readonly appendTranscriptEntry: ReturnType<typeof vi.fn>
  readonly updateActivityPane: ReturnType<typeof vi.fn>
  readonly syncBackgroundAgentBadge: ReturnType<typeof vi.fn>
  readonly backgroundTasks: Map<string, BackgroundTaskInfo>
  readonly backgroundTaskTranscriptedTerminal: Set<string>
  /** parentToolCallId → transcript entry id, mirroring streamingUI's map. */
  readonly toolComponents: Map<string, string>
  readonly activeToolCalls: Map<string, ToolCallBlockData>
}

function makeSpawned(overrides: Partial<SpawnedEvent> = {}): SubagentLifecycleEvent {
  return {
    type: 'subagent.spawned',
    sessionId: 's1',
    subagentId: 'child-1',
    subagentName: 'helper',
    parentToolCallId: 'parent-1',
    description: 'do the thing',
    runInBackground: false,
    thinkingEffort: 'high',
    model: 'kimi-k2',
    ...overrides,
  } as SubagentLifecycleEvent
}

function setupHarness(): Harness {
  const store = createTui2Store()
  const toolComponents = new Map<string, string>()
  const activeToolCalls = new Map<string, ToolCallBlockData>()

  const streamingUI = {
    getToolComponent: vi.fn((id: string): string | undefined => toolComponents.get(id)),
    getActiveToolCall: vi.fn((id: string): ToolCallBlockData | undefined => activeToolCalls.get(id)),
    onToolCallStart: vi.fn((toolCall: ToolCallBlockData) => {
      const entryId = `entry-${toolCall.id}`
      toolComponents.set(toolCall.id, entryId)
      activeToolCalls.set(toolCall.id, toolCall)
      store.setState('transcript', (entries) => [
        ...entries,
        { id: entryId, kind: 'tool_call', turnId: 0, step: 0, toolCallData: toolCall } as unknown as TranscriptEntry,
      ])
    }),
    getTurnContext: vi.fn(() => ({ turnId: 0, step: 0 })),
    finalizeLiveTextBuffers: vi.fn(),
    removeToolComponentIfInactive: vi.fn(),
    applyBackgroundTaskTerminalStatus: vi.fn(() => true),
  }

  const appendTranscriptEntry = vi.fn()
  const updateActivityPane = vi.fn()
  const syncBackgroundAgentBadge = vi.fn()

  const host = {
    store,
    btwPanelController: { routeEvent: vi.fn(() => false) },
    streamingUI: streamingUI as unknown as StreamingUIController,
    appendTranscriptEntry,
    updateActivityPane,
  } as unknown as SessionEventHost

  const backgroundTasks = new Map<string, BackgroundTaskInfo>()
  const backgroundTaskTranscriptedTerminal = new Set<string>()

  const handler = new SubAgentEventHandler(host, {
    backgroundTasks,
    backgroundTaskTranscriptedTerminal,
    syncBackgroundAgentBadge,
  })

  return {
    handler,
    store,
    streamingUI,
    appendTranscriptEntry,
    updateActivityPane,
    syncBackgroundAgentBadge,
    backgroundTasks,
    backgroundTaskTranscriptedTerminal,
    toolComponents,
    activeToolCalls,
  }
}

/** Spawn a foreground subagent so `subagentInfo` + the parent tool entry exist. */
function spawnForeground(harness: Harness, overrides: Partial<SpawnedEvent> = {}): void {
  harness.activeToolCalls.set('parent-1', {
    id: 'parent-1',
    name: 'Agent',
    args: { description: 'do the thing' },
  } as ToolCallBlockData)
  harness.handler.handleLifecycleEvent(makeSpawned(overrides))
}

function childEntry(harness: Harness): TranscriptEntry | undefined {
  const entryId = harness.toolComponents.get('parent-1')
  return entryId === undefined
    ? undefined
    : harness.store.state.transcript.find((entry) => entry.id === entryId)
}

describe('SubAgentEventHandler.routeChildAgentEvent', () => {
  it('returns false for lifecycle events (handled elsewhere)', () => {
    const { handler } = setupHarness()
    expect(handler.routeChildAgentEvent(makeSpawned())).toBe(false)
  })

  it('returns false for main-agent events', () => {
    const { handler } = setupHarness()
    const handled = handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: MAIN_AGENT_ID,
      delta: 'x',
    } as Event)
    expect(handled).toBe(false)
  })

  it('tees child-agent events into the activity store before routing', () => {
    const { handler } = setupHarness()
    handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'mystery-agent',
      delta: 'hi',
    } as Event)
    expect(handler.activityStore.get('mystery-agent')?.steps[0]?.textTail).toBe('hi')
  })

  it('accumulates child assistant deltas into the parent tool entry', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    harness.handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'child-1',
      delta: 'Hello ',
    } as Event)
    harness.handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'child-1',
      delta: 'world',
    } as Event)

    expect(childEntry(harness)?.toolCallData?.subagent?.text).toBe('Hello world')
    expect(childEntry(harness)?.toolCallData?.subagent?.name).toBe('helper')
  })

  it('appends a child tool call with the agent-prefixed id', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    harness.handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'child-1',
      toolCallId: 'tc-1',
      name: 'Bash',
      args: { command: 'ls' },
    } as Event)

    const call = childEntry(harness)?.toolCallData?.subagent?.toolCalls?.[0]
    expect(call?.id).toBe('child-1:tc-1')
    expect(call?.name).toBe('Bash')
    expect(call?.args).toEqual({ command: 'ls' })
  })

  it('updates a child tool call args from its delta', () => {
    const harness = setupHarness()
    spawnForeground(harness)
    harness.handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'child-1',
      toolCallId: 'tc-1',
      name: 'Bash',
      args: {},
    } as Event)

    harness.handler.routeChildAgentEvent({
      type: 'tool.call.delta',
      agentId: 'child-1',
      toolCallId: 'tc-1',
      argumentsPart: '{"cmd":"ls -la',
    } as Event)

    const call = childEntry(harness)?.toolCallData?.subagent?.toolCalls?.[0]
    expect(call?.args).toMatchObject({ argumentsText: '{"cmd":"ls -la' })
  })

  it('attaches the result to the matching child tool call', () => {
    const harness = setupHarness()
    spawnForeground(harness)
    harness.handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'child-1',
      toolCallId: 'tc-1',
      name: 'Bash',
      args: {},
    } as Event)

    harness.handler.routeChildAgentEvent({
      type: 'tool.result',
      agentId: 'child-1',
      toolCallId: 'tc-1',
      output: 'ok',
      isError: false,
    } as Event)

    const call = childEntry(harness)?.toolCallData?.subagent?.toolCalls?.[0]
    expect(call?.result?.output).toBe('ok')
    expect(call?.result?.is_error).toBe(false)
  })

  it('records model display and metrics on agent.status.updated', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    harness.handler.routeChildAgentEvent({
      type: 'agent.status.updated',
      agentId: 'child-1',
      model: 'kimi-k2',
      contextTokens: 100,
      usage: { currentTurn: { input: 10, output: 20 } },
    } as unknown as Event)

    const subagent = childEntry(harness)?.toolCallData?.subagent
    expect(subagent?.model).toBeTruthy()
    expect(subagent?.text).toContain('100 ctx')
  })

  it('swallows events for an unknown subagent without crashing', () => {
    const { handler } = setupHarness()
    const handled = handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'no-such-agent',
      delta: 'x',
    } as Event)
    expect(handled).toBe(true)
  })
})

describe('SubAgentEventHandler.handleLifecycleEvent', () => {
  it('foreground spawn remembers the subagent and activates the parent entry', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    expect(harness.handler.subagentInfo.get('child-1')).toMatchObject({
      parentToolCallId: 'parent-1',
      name: 'helper',
      runInBackground: false,
    })
    expect(harness.handler.activityStore.get('child-1')).toBeDefined()
    expect(childEntry(harness)?.toolCallData?.subagent?.name).toBe('helper')
  })

  it('background spawn records metadata, transcribes a started entry, and syncs the badge', () => {
    const harness = setupHarness()

    harness.handler.handleLifecycleEvent(makeSpawned({ runInBackground: true }))

    expect(harness.handler.backgroundAgentMetadata.get('child-1')).toMatchObject({
      agentId: 'child-1',
      parentToolCallId: 'parent-1',
      agentName: 'helper',
      description: 'do the thing',
    })
    expect(harness.syncBackgroundAgentBadge).toHaveBeenCalled()
    const entry = harness.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry
    expect(entry.backgroundAgentStatus?.phase).toBe('started')
  })

  it('background completion transcribes a completed entry once', () => {
    const harness = setupHarness()
    harness.backgroundTasks.set('task-1', {
      taskId: 'task-1',
      kind: 'agent',
      agentId: 'child-1',
      description: 'do the thing',
      status: 'running',
      startedAt: new Date(0),
    } as unknown as BackgroundTaskInfo)

    harness.handler.handleLifecycleEvent(makeSpawned({ runInBackground: true }))
    harness.handler.handleLifecycleEvent({
      type: 'subagent.completed',
      subagentId: 'child-1',
      resultSummary: 'done',
    } as SubagentLifecycleEvent)

    const entry = harness.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry
    expect(entry.backgroundAgentStatus?.phase).toBe('completed')
    expect(harness.handler.backgroundAgentMetadata.has('child-1')).toBe(false)
    expect(harness.backgroundTaskTranscriptedTerminal.has('task-1')).toBe(true)
  })

  it('background failure applies the terminal status and transcribes a failed entry', () => {
    const harness = setupHarness()
    harness.backgroundTasks.set('task-1', {
      taskId: 'task-1',
      kind: 'agent',
      agentId: 'child-1',
      description: 'do the thing',
      status: 'running',
      startedAt: new Date(0),
    } as unknown as BackgroundTaskInfo)

    harness.handler.handleLifecycleEvent(makeSpawned({ runInBackground: true }))
    harness.handler.handleLifecycleEvent({
      type: 'subagent.failed',
      subagentId: 'child-1',
      error: 'boom',
    } as SubagentLifecycleEvent)

    expect(harness.streamingUI.applyBackgroundTaskTerminalStatus).toHaveBeenCalledWith({
      agentId: 'child-1',
      description: 'do the thing',
      status: 'failed',
      errorText: 'boom',
    })
    const entry = harness.appendTranscriptEntry.mock.calls.at(-1)?.[0] as TranscriptEntry
    expect(entry.backgroundAgentStatus?.phase).toBe('failed')
  })

  it('foreground completion appends the result summary to the subagent text', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    harness.handler.handleLifecycleEvent({
      type: 'subagent.completed',
      subagentId: 'child-1',
      resultSummary: 'all good',
    } as SubagentLifecycleEvent)

    expect(childEntry(harness)?.toolCallData?.subagent?.text).toBe('all good')
  })
})

describe('SubAgentEventHandler swarm progress', () => {
  it('publishes agentSwarmData with running status after the tool call starts', () => {
    const harness = setupHarness()
    spawnForeground(harness)

    harness.handler.handleAgentSwarmToolCallStarted('parent-1', {
      description: 'swarm',
      agents: 2,
    })
    const entry = childEntry(harness)
    expect(entry?.agentSwarmData?.status).toBe('running')
    expect(entry?.agentSwarmData?.description).toBe('swarm')
    expect(harness.streamingUI.finalizeLiveTextBuffers).toHaveBeenCalledWith('tool')
  })

  it('marks a user-aborted swarm result as cancelled', () => {
    const harness = setupHarness()
    spawnForeground(harness)
    harness.handler.handleAgentSwarmToolCallStarted('parent-1', { description: 'swarm' })

    harness.handler.handleAgentSwarmToolResult(
      'parent-1',
      { tool_call_id: 'parent-1', output: '', is_error: false } as never,
      true,
    )

    expect(harness.handler.hasActiveAgentSwarmToolCall()).toBe(false)
    expect(childEntry(harness)?.agentSwarmData?.status).toBe('ended')
  })

  it('markActiveAgentSwarmsCancelled flags open swarms but does not end them', () => {
    const harness = setupHarness()
    spawnForeground(harness)
    harness.handler.handleAgentSwarmToolCallStarted('parent-1', { description: 'swarm' })
    expect(harness.handler.hasActiveAgentSwarmToolCall()).toBe(true)

    harness.handler.markActiveAgentSwarmsCancelled()

    // The cancellation flag alone does not end the swarm — `toolCallEnded`
    // stays false and the published status remains 'running'; ending happens
    // through the tool result (`handleAgentSwarmToolResult`).
    expect(harness.handler.hasActiveAgentSwarmToolCall()).toBe(true)
    expect(childEntry(harness)?.agentSwarmData?.status).toBe('running')
  })
})

describe('SubAgentEventHandler reset & prune', () => {
  it('resetRuntimeState clears info, metadata, activity store, and swarm progress', () => {
    const harness = setupHarness()
    spawnForeground(harness)
    harness.handler.handleLifecycleEvent(makeSpawned({ runInBackground: true, subagentId: 'bg-1' }))

    harness.handler.resetRuntimeState()

    expect(harness.handler.subagentInfo.size).toBe(0)
    expect(harness.handler.backgroundAgentMetadata.size).toBe(0)
    expect(harness.handler.activityStore.agentIds()).toEqual([])
    expect(harness.updateActivityPane).toHaveBeenCalled()
  })

  it('dropForegroundOnlyActivityRecords keeps records that back a background task', () => {
    const harness = setupHarness()
    harness.backgroundTasks.set('task-1', {
      taskId: 'task-1',
      kind: 'agent',
      agentId: 'child-1',
      status: 'running',
      startedAt: new Date(0),
    } as unknown as BackgroundTaskInfo)
    spawnForeground(harness)

    harness.handler.dropForegroundOnlyActivityRecords()

    expect(harness.handler.activityStore.get('child-1')).toBeDefined()
  })
})
