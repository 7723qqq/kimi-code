/**
 * Tests for `SessionEventHandler` — session events → response store.
 *
 * The handler mirrors the v1 pi-tui controller but writes transcript entries
 * and app-state patches into the tui2 response store instead of mounting
 * pi-tui components. The host is a fiducial mock (real `Tui2Store`, mocked
 * streamingUI/tasks-browser/host callbacks); `SubAgentEventHandler` and
 * `PluginUpdateNotifier` are the real classes instantiated by the
 * constructor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Event, Session } from '@moonshot-ai/kimi-code-sdk'

import {
  SessionEventHandler,
  TOOL_PROGRESS_COALESCE_MS,
  type SessionEventHost,
} from '@/tui2/controllers/session-event-handler'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { TranscriptEntry } from '@/tui2/types'

interface StreamingUIMock {
  setTurnId: ReturnType<typeof vi.fn>
  resetToolUi: ReturnType<typeof vi.fn>
  setStep: ReturnType<typeof vi.fn>
  flushNow: ReturnType<typeof vi.fn>
  getTurnContext: ReturnType<typeof vi.fn>
  setTodoList: ReturnType<typeof vi.fn>
  finalizeTurn: ReturnType<typeof vi.fn>
  finalizeLiveTextBuffers: ReturnType<typeof vi.fn>
  markStepTruncated: ReturnType<typeof vi.fn>
  hasThinkingDraft: ReturnType<typeof vi.fn>
  appendThinkingDelta: ReturnType<typeof vi.fn>
  scheduleFlush: ReturnType<typeof vi.fn>
  flushThinkingToTranscript: ReturnType<typeof vi.fn>
  appendAssistantDelta: ReturnType<typeof vi.fn>
  finalizeAssistantStream: ReturnType<typeof vi.fn>
  registerToolCall: ReturnType<typeof vi.fn>
  accumulateToolCallDelta: ReturnType<typeof vi.fn>
  getStreamingToolCallPreview: ReturnType<typeof vi.fn>
  getActiveToolCall: ReturnType<typeof vi.fn>
  getToolComponent: ReturnType<typeof vi.fn>
  completeToolResult: ReturnType<typeof vi.fn>
  beginCompaction: ReturnType<typeof vi.fn>
  endCompaction: ReturnType<typeof vi.fn>
  cancelCompaction: ReturnType<typeof vi.fn>
  hasActiveTurn: ReturnType<typeof vi.fn>
  markSubagentBackgrounded: ReturnType<typeof vi.fn>
  applyBackgroundTaskTerminalStatus: ReturnType<typeof vi.fn>
}

interface Harness {
  readonly handler: SessionEventHandler
  readonly host: SessionEventHost
  readonly store: Tui2Store
  readonly streamingUI: StreamingUIMock
  readonly setAppState: ReturnType<typeof vi.fn>
  readonly patchLivePane: ReturnType<typeof vi.fn>
  readonly resetLivePane: ReturnType<typeof vi.fn>
  readonly showError: ReturnType<typeof vi.fn>
  readonly showStatus: ReturnType<typeof vi.fn>
  readonly showNotice: ReturnType<typeof vi.fn>
  readonly recordSessionActivity: ReturnType<typeof vi.fn>
  readonly noteStepUsage: ReturnType<typeof vi.fn>
  readonly noteStepCacheStats: ReturnType<typeof vi.fn>
  readonly noteSessionStepCompleted: ReturnType<typeof vi.fn>
  readonly noteSessionToolCompleted: ReturnType<typeof vi.fn>
  readonly noteCompactionFinished: ReturnType<typeof vi.fn>
  readonly noteSessionTurnStarted: ReturnType<typeof vi.fn>
  readonly updateTerminalTitle: ReturnType<typeof vi.fn>
  readonly appendTranscriptEntry: ReturnType<typeof vi.fn>
  readonly shiftQueuedMessage: ReturnType<typeof vi.fn>
  readonly repaint: ReturnType<typeof vi.fn>
  readonly refreshOutputViewer: ReturnType<typeof vi.fn>
  readonly entries: TranscriptEntry[]
}

function makeStreamingUI(): StreamingUIMock {
  return {
    setTurnId: vi.fn(),
    resetToolUi: vi.fn(),
    setStep: vi.fn(),
    flushNow: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    setTodoList: vi.fn(),
    finalizeTurn: vi.fn(),
    finalizeLiveTextBuffers: vi.fn(),
    markStepTruncated: vi.fn(() => 0),
    hasThinkingDraft: vi.fn(() => false),
    appendThinkingDelta: vi.fn(),
    scheduleFlush: vi.fn(),
    flushThinkingToTranscript: vi.fn(),
    appendAssistantDelta: vi.fn(),
    finalizeAssistantStream: vi.fn(),
    registerToolCall: vi.fn(),
    accumulateToolCallDelta: vi.fn(),
    getStreamingToolCallPreview: vi.fn(() => undefined),
    getActiveToolCall: vi.fn(() => undefined),
    getToolComponent: vi.fn(() => undefined),
    completeToolResult: vi.fn(() => undefined),
    beginCompaction: vi.fn(),
    endCompaction: vi.fn(),
    cancelCompaction: vi.fn(),
    hasActiveTurn: vi.fn(() => false),
    markSubagentBackgrounded: vi.fn(),
    applyBackgroundTaskTerminalStatus: vi.fn(),
  }
}

function setup(options?: { session?: Session }): Harness {
  const store = createTui2Store({ workDir: '/ws' })
  const streamingUI = makeStreamingUI()
  const entries: TranscriptEntry[] = []
  const session = options?.session

  const setAppState = vi.fn()
  const patchLivePane = vi.fn()
  const resetLivePane = vi.fn()
  const showError = vi.fn()
  const showStatus = vi.fn()
  const showNotice = vi.fn()
  const recordSessionActivity = vi.fn()
  const noteStepUsage = vi.fn()
  const noteStepCacheStats = vi.fn()
  const noteSessionStepCompleted = vi.fn()
  const noteSessionToolCompleted = vi.fn()
  const noteCompactionFinished = vi.fn()
  const noteSessionTurnStarted = vi.fn()
  const updateTerminalTitle = vi.fn()
  const appendTranscriptEntry = vi.fn((entry: TranscriptEntry) => {
    entries.push(entry)
  })
  const shiftQueuedMessage = vi.fn(() => undefined)
  const repaint = vi.fn()
  const refreshOutputViewer = vi.fn(async () => {})

  const host: SessionEventHost = {
    store,
    session,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: streamingUI as never,
    requireSession: () => session as Session,
    setAppState,
    patchLivePane,
    resetLivePane,
    showError,
    showStatus,
    showNotice,
    updateActivityPane: vi.fn(),
    track: vi.fn(),
    recordSessionActivity,
    noteStepUsage,
    noteStepCacheStats,
    noteSessionTurnStarted,
    noteSessionStepCompleted,
    noteSessionToolCompleted,
    noteCompactionFinished,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry,
    handleShellOutput: vi.fn(),
    handleShellStarted: vi.fn(),
    sendNormalUserInput: vi.fn(),
    updateTerminalTitle,
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage,
    sendSkillActivation: vi.fn(),
    hasPendingBundledSkill: vi.fn(() => false),
    lastDispatchedUserEntryId: undefined,
    btwPanelController: { routeEvent: vi.fn(() => false) } as never,
    tasksBrowserController: { repaint, refreshOutputViewer } as never,
  }

  const handler = new SessionEventHandler(host)
  return {
    handler,
    host,
    store,
    streamingUI,
    setAppState,
    patchLivePane,
    resetLivePane,
    showError,
    showStatus,
    showNotice,
    recordSessionActivity,
    noteStepUsage,
    noteStepCacheStats,
    noteSessionStepCompleted,
    noteSessionToolCompleted,
    noteCompactionFinished,
    noteSessionTurnStarted,
    updateTerminalTitle,
    appendTranscriptEntry,
    shiftQueuedMessage,
    repaint,
    refreshOutputViewer,
    entries,
  }
}

// Main-agent events always carry `agentId: 'main'`; `routeChildAgentEvent`
// returns true (and swallows) any event without a main/sub agent id, so
// inject the main id unless the fixture overrides it with a child id.
// Fixtures are loosely-typed event shapes; the cast is centralized here.
const handle = (h: Harness, event: unknown): void => {
  h.handler.handleEvent(
    { agentId: 'main', ...(event as Record<string, unknown>) } as unknown as Event,
    () => {},
  )
}

describe('SessionEventHandler event routing', () => {
  it('sets the turn id from events that carry one', () => {
    const h = setup()
    handle(h, { type: 'turn.started', turnId: 7 })
    expect(h.streamingUI.setTurnId).toHaveBeenCalledWith('7')
  })

  it('tees child-agent events into the subagent handler and stops routing', () => {
    const h = setup()
    h.handler.subAgentEventHandler.activityStore.get('child-1')
    handle(h, { type: 'assistant.delta', agentId: 'child-1', delta: 'hi' })
    // Teed into the activity store and swallowed — no turn-level handlers ran.
    expect(h.handler.subAgentEventHandler.activityStore.get('child-1')?.steps[0]?.textTail).toBe('hi')
    expect(h.streamingUI.appendAssistantDelta).not.toHaveBeenCalled()
  })
})

describe('SessionEventHandler turn lifecycle', () => {
  it('turn.started resets tool UI, sets step 0, and enters the waiting pane', () => {
    const h = setup()
    handle(h, { type: 'turn.started', turnId: 1 })
    expect(h.streamingUI.resetToolUi).toHaveBeenCalled()
    expect(h.streamingUI.setStep).toHaveBeenCalledWith(0)
    expect(h.patchLivePane).toHaveBeenCalledWith({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    })
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ streamingPhase: 'waiting' }),
    )
    expect(h.noteSessionTurnStarted).toHaveBeenCalled()
  })

  it('turn.ended cancels active swarms, finalizes the turn, and records activity', () => {
    const h = setup()
    const markCancelled = vi.spyOn(h.handler.subAgentEventHandler, 'markActiveAgentSwarmsCancelled')
    handle(h, { type: 'turn.ended', turnId: 1, reason: 'cancelled' })
    expect(markCancelled).toHaveBeenCalled()
    expect(h.streamingUI.finalizeTurn).toHaveBeenCalled()
    expect(h.recordSessionActivity).toHaveBeenCalled()
  })

  it('turn.ended blocked shows the blocked status', () => {
    const h = setup()
    handle(h, { type: 'turn.ended', turnId: 1, reason: 'blocked' })
    expect(h.showStatus).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('turn.ended failed provider.filtered shows the filtered status', () => {
    const h = setup()
    handle(h, { type: 'turn.ended', turnId: 1, reason: 'failed', error: { code: 'provider.filtered' } })
    expect(h.showStatus).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('turn.ended clears the todo list when every todo is done', () => {
    const h = setup()
    h.store.setState('todoItems', [
      { title: 'a', status: 'done' },
      { title: 'b', status: 'done' },
    ])
    handle(h, { type: 'turn.ended', turnId: 1, reason: 'done' })
    expect(h.streamingUI.setTodoList).toHaveBeenCalledWith([])
  })
})

describe('SessionEventHandler step lifecycle', () => {
  it('step.started sets the step and parks the pane in waiting', () => {
    const h = setup()
    handle(h, { type: 'turn.step.started', turnId: 1, step: 2 })
    expect(h.streamingUI.setStep).toHaveBeenCalledWith(2)
    expect(h.streamingUI.finalizeLiveTextBuffers).toHaveBeenCalledWith('waiting')
    expect(h.patchLivePane).toHaveBeenCalledWith(expect.objectContaining({ mode: 'waiting' }))
  })

  it('step.completed reports usage and cache stats', () => {
    const h = setup()
    const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as never
    handle(h, {
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      usage,
      llmStreamDurationMs: 100,
      llmFirstTokenLatencyMs: 10,
    })
    expect(h.noteStepUsage).toHaveBeenCalledWith(usage)
    expect(h.noteStepCacheStats).toHaveBeenCalledWith(usage, 100)
    expect(h.noteSessionStepCompleted).toHaveBeenCalledWith(usage, 100, 10)
  })

  it('step.completed max_tokens shows the truncation notice', () => {
    const h = setup()
    h.streamingUI.markStepTruncated.mockReturnValue(1)
    handle(h, { type: 'turn.step.completed', turnId: 1, step: 1, finishReason: 'max_tokens' })
    expect(h.streamingUI.markStepTruncated).toHaveBeenCalledWith('1', 1)
    // Non-Anthropic session → no hint detail.
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), undefined)
  })

  it('step.completed filtered shows the policy-blocked notice', () => {
    const h = setup()
    handle(h, {
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      providerFinishReason: 'filtered',
      rawFinishReason: 'content_filter',
    })
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('content_filter'))
  })

  it('step.interrupted aborted shows the interrupted-by-user status', () => {
    const h = setup()
    handle(h, { type: 'turn.step.interrupted', turnId: 1, step: 1, reason: 'aborted' })
    expect(h.showStatus).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('step.retrying parks the pane and records the backoff state', () => {
    const h = setup()
    handle(h, {
      type: 'turn.step.retrying',
      turnId: 1,
      step: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorName: 'Timeout',
      errorMessage: 'boom',
    })
    expect(h.patchLivePane).toHaveBeenCalledWith({ mode: 'waiting' })
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({
        streamingPhase: 'waiting',
        stepRetry: expect.objectContaining({ nextAttempt: 2, maxAttempts: 3, phase: 'backoff' }),
      }),
    )
  })
})

describe('SessionEventHandler streaming deltas', () => {
  it('thinking.delta enters the thinking phase and counts output tokens', () => {
    const h = setup()
    handle(h, { type: 'thinking.delta', delta: 'reasoning…' })
    expect(h.streamingUI.appendThinkingDelta).toHaveBeenCalledWith('reasoning…')
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ streamingPhase: 'thinking' }),
    )
    // 9 ASCII + 1 non-ASCII char → ceil(9/4 + 1) = 4.
    expect(h.setAppState).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 4 }))
  })

  it('empty thinking delta with no draft keeps the waiting spinner (no phase switch)', () => {
    const h = setup()
    handle(h, { type: 'thinking.delta', delta: ' ' })
    expect(h.streamingUI.appendThinkingDelta).not.toHaveBeenCalled()
    expect(h.setAppState).not.toHaveBeenCalledWith(expect.objectContaining({ streamingPhase: 'thinking' }))
  })

  it('assistant.delta flushes a pending thinking draft and enters composing', () => {
    const h = setup()
    h.streamingUI.hasThinkingDraft.mockReturnValue(true)
    handle(h, { type: 'assistant.delta', delta: 'hello' })
    expect(h.streamingUI.flushThinkingToTranscript).toHaveBeenCalledWith('idle')
    expect(h.streamingUI.appendAssistantDelta).toHaveBeenCalledWith('hello')
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ streamingPhase: 'composing' }),
    )
  })
})

describe('SessionEventHandler tool calls', () => {
  it('tool.call.started registers the tool call and switches to the tool pane', () => {
    const h = setup()
    handle(h, { type: 'tool.call.started', toolCallId: 'c1', name: 'Bash', args: { command: 'ls' } })
    expect(h.streamingUI.registerToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', name: 'Bash', args: { command: 'ls' } }),
    )
    expect(h.patchLivePane).toHaveBeenCalledWith(expect.objectContaining({ mode: 'tool' }))
  })

  it('tool.call.delta accumulates the args and marks composing', () => {
    const h = setup()
    handle(h, { type: 'tool.call.delta', toolCallId: 'c1', name: 'Bash', argumentsPart: '{"com' })
    expect(h.streamingUI.accumulateToolCallDelta).toHaveBeenCalledWith('c1', 'Bash', '{"com')
    expect(h.setAppState).toHaveBeenCalledWith(expect.objectContaining({ streamingPhase: 'composing' }))
  })

  it('tool.result completes the call, notes the duration, and returns to waiting', () => {
    const h = setup()
    // A matching started event records the start timestamp the result needs.
    handle(h, { type: 'tool.call.started', toolCallId: 'c1', name: 'Bash', args: {} })
    h.streamingUI.completeToolResult.mockReturnValue({ id: 'c1', name: 'Bash', args: {} } as never)
    handle(h, { type: 'tool.result', toolCallId: 'c1', output: 'out', isError: false })
    expect(h.streamingUI.completeToolResult).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ tool_call_id: 'c1', output: 'out', is_error: false }),
    )
    expect(h.noteSessionToolCompleted).toHaveBeenCalledWith(expect.any(Number))
    expect(h.patchLivePane).toHaveBeenCalledWith({ mode: 'waiting' })
  })

  it('tool.result for TodoList sets the sanitized todo list', () => {
    const h = setup()
    h.streamingUI.completeToolResult.mockReturnValue({
      id: 'c1',
      name: 'TodoList',
      args: { todos: [{ title: 'a', status: 'pending' }, { title: 'bad' }] },
    } as never)
    handle(h, { type: 'tool.result', toolCallId: 'c1', output: '', isError: false })
    // Normalization keeps the tree fields (id/parentId/kind/progress) with
    // defaults filled in, so the panel's milestone branch gets real data.
    expect(h.streamingUI.setTodoList).toHaveBeenCalledWith([
      {
        id: undefined,
        parentId: null,
        kind: 'task',
        title: 'a',
        status: 'pending',
        progress: undefined,
      },
    ])
  })
})

describe('SessionEventHandler compaction', () => {
  it('compaction.started enters the compacting state and begins the compaction UI', () => {
    const h = setup()
    handle(h, { type: 'compaction.started', instruction: 'summarize' })
    expect(h.streamingUI.beginCompaction).toHaveBeenCalledWith('summarize')
    expect(h.setAppState).toHaveBeenCalledWith(expect.objectContaining({ isCompacting: true }))
  })

  it('compaction.completed ends the compaction and counts it as activity', () => {
    const h = setup()
    handle(h, {
      type: 'compaction.completed',
      result: { tokensBefore: 100, tokensAfter: 20, summary: 's' },
    })
    expect(h.streamingUI.endCompaction).toHaveBeenCalledWith(100, 20, 's')
    expect(h.noteCompactionFinished).toHaveBeenCalled()
    expect(h.recordSessionActivity).toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ isCompacting: false, streamingPhase: 'idle' }),
    )
  })

  it('compaction.cancelled cancels the compaction UI without activity', () => {
    const h = setup()
    handle(h, { type: 'compaction.cancelled' })
    expect(h.streamingUI.cancelCompaction).toHaveBeenCalled()
    expect(h.recordSessionActivity).not.toHaveBeenCalled()
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ isCompacting: false, streamingPhase: 'idle' }),
    )
  })
})

describe('SessionEventHandler background tasks', () => {
  it('task.started for an agent marks the card backgrounded and repaints', () => {
    const h = setup()
    handle(h, {
      type: 'task.started',
      info: { taskId: 't1', kind: 'agent', agentId: 'a1', description: 'bg', status: 'running' },
    })
    expect(h.streamingUI.markSubagentBackgrounded).toHaveBeenCalledWith('a1')
    expect(h.repaint).toHaveBeenCalled()
    expect(h.refreshOutputViewer).toHaveBeenCalledWith({ silent: true })
  })

  it('task.started for a process appends a status entry', () => {
    const h = setup()
    handle(h, {
      type: 'task.started',
      info: { taskId: 't1', kind: 'process', description: 'sleep 10', status: 'running', command: 'sleep 10' },
    })
    expect(h.entries.some((entry) => entry.kind === 'status')).toBe(true)
  })

  it('task.terminated for a terminal agent applies the status to the card', () => {
    const h = setup()
    handle(h, {
      type: 'task.terminated',
      info: { taskId: 't1', kind: 'agent', agentId: 'a1', description: 'bg', status: 'failed' },
    })
    expect(h.streamingUI.applyBackgroundTaskTerminalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', status: 'failed' }),
    )
  })

  it('task.terminated marks the activity record failed for a running agent', () => {
    const h = setup()
    const { handler } = h
    // Simulate a running record first, then terminate it as failed.
    handler.subAgentEventHandler.activityStore.applyEvent({
      sessionId: 's1',
      agentId: 'a1',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    })
    handle(h, {
      type: 'task.terminated',
      info: { taskId: 't1', kind: 'agent', agentId: 'a1', description: 'bg', status: 'failed' },
    })
    expect(handler.subAgentEventHandler.activityStore.get('a1')?.status).toBe('failed')
  })
})

describe('SessionEventHandler skill / plugin activation', () => {
  it('skill.activated appends an entry and dedupes repeats', () => {
    const h = setup()
    handle(h, { type: 'skill.activated', activationId: 'sk-1', skillName: 'web', trigger: 'user-slash' })
    handle(h, { type: 'skill.activated', activationId: 'sk-1', skillName: 'web', trigger: 'user-slash' })
    const skills = h.entries.filter((entry) => entry.kind === 'skill_activation')
    expect(skills).toHaveLength(1)
    expect(skills[0]?.skillActivationId).toBe('sk-1')
    expect(skills[0]?.content).toContain('web')
  })

  it('plugin_command.activated appends an entry and dedupes repeats', () => {
    const h = setup()
    handle(h, { type: 'plugin_command.activated', activationId: 'pc-1', pluginId: 'hello', commandName: 'world' })
    handle(h, { type: 'plugin_command.activated', activationId: 'pc-1', pluginId: 'hello', commandName: 'world' })
    const rows = h.entries.filter((entry) => entry.kind === 'plugin_command')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.pluginCommandData).toMatchObject({ pluginId: 'hello', commandName: 'world' })
  })
})

describe('SessionEventHandler errors and warnings', () => {
  it('error with the OAuth-login code shows the login-required notice', () => {
    const h = setup()
    handle(h, { type: 'error', code: 401, message: 'unauthorized' })
    expect(h.showError).toHaveBeenCalled()
  })

  it('error shows the formatted payload and a report hint when a session exists', () => {
    const h = setup()
    h.store.setState('sessionId', 's1')
    handle(h, { type: 'error', message: 'boom' })
    expect(h.showError).toHaveBeenCalledWith(expect.any(String))
    expect(h.showStatus).toHaveBeenCalledWith(expect.any(String))
  })

  it('warning surfaces through showStatus with the warning color', () => {
    const h = setup()
    handle(h, { type: 'warning', message: 'careful' })
    expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining('careful'), 'warning')
  })
})

describe('SessionEventHandler session meta and status', () => {
  it('session.meta.updated title patches the app state and refreshes the terminal title', () => {
    const h = setup()
    handle(h, { type: 'session.meta.updated', title: 'My Chat' })
    expect(h.setAppState).toHaveBeenCalledWith({ sessionTitle: 'My Chat' })
    expect(h.updateTerminalTitle).toHaveBeenCalled()
  })

  it('agent.status.updated computes context usage and patches model/plan/swarm', () => {
    const h = setup()
    handle(h, {
      type: 'agent.status.updated',
      contextTokens: 500,
      maxContextTokens: 1000,
      model: 'kimi-k2',
      planMode: true,
      swarmMode: true,
    })
    expect(h.setAppState).toHaveBeenCalledWith(
      expect.objectContaining({ contextUsage: 0.5, model: 'kimi-k2', planMode: true, swarmMode: true }),
    )
  })

  it('agent.status.updated renders an ended swarm marker when leaving task swarm mode', () => {
    const h = setup()
    h.store.setState('swarmMode', true)
    h.store.setState('swarmModeEntry', 'task')
    handle(h, { type: 'agent.status.updated', swarmMode: false })
    expect(h.entries.some((entry) => entry.swarmData?.state === 'ended')).toBe(true)
  })
})

describe('SessionEventHandler MCP server status', () => {
  it('mcp.server.status connected appends a success row once', () => {
    const h = setup()
    handle(h, { type: 'mcp.server.status', server: { name: 'filesystem', status: 'connected', toolCount: 3, transport: 'stdio' } })
    handle(h, { type: 'mcp.server.status', server: { name: 'filesystem', status: 'connected', toolCount: 3, transport: 'stdio' } })
    const rows = h.entries.filter((entry) => entry.kind === 'status' && entry.color === 'success')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toContain('filesystem')
  })

  it('mcp.server.status failed appends an error row', () => {
    const h = setup()
    handle(h, { type: 'mcp.server.status', server: { name: 'db', status: 'failed', error: 'conn refused' } })
    const row = h.entries.find((entry) => entry.color === 'error')
    expect(row?.content).toContain('db')
  })
})

describe('SessionEventHandler goal updates', () => {
  it('goal.updated completion appends a deterministic completion entry', () => {
    const h = setup()
    handle(h, {
      type: 'goal.updated',
      snapshot: { id: 'g1', objective: 'build', status: 'completed' },
      change: { kind: 'completion' },
    } as unknown)
    const entry = h.entries.find((e) => e.goalCompletionData === true)
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('assistant')
  })

  it('goal.updated lifecycle appends a goal marker entry', () => {
    const h = setup()
    handle(h, {
      type: 'goal.updated',
      snapshot: { id: 'g1', objective: 'build', status: 'paused' },
      change: { kind: 'lifecycle', status: 'blocked', actor: 'user', reason: 'x' },
    } as unknown)
    expect(h.entries.some((entry) => entry.kind === 'goal')).toBe(true)
  })
})

describe('SessionEventHandler runtime reset', () => {
  it('resetRuntimeState clears task/skill/plugin/MCP state', () => {
    const h = setup()
    handle(h, { type: 'mcp.server.status', server: { name: 's', status: 'connected', toolCount: 1, transport: 'stdio' } })
    handle(h, { type: 'skill.activated', activationId: 'sk-1', skillName: 'web' })
    h.handler.resetRuntimeState()
    expect(h.handler.renderedSkillActivationIds.size).toBe(0)
    expect(h.handler.renderedMcpServerStatusKeys.size).toBe(0)
    expect(h.handler.mcpServers.size).toBe(0)
    expect(h.handler.backgroundTasks.size).toBe(0)
  })
})

describe('SessionEventHandler queued skill activations', () => {
  it('routes a drained skill item through sendSkillActivation instead of the prompt path', async () => {
    let capturedEmit: ((event: Event) => void) | undefined
    const session = {
      id: 's1',
      onEvent: vi.fn((cb: (event: Event) => void) => {
        capturedEmit = cb
        return () => {}
      }),
      listMcpServers: vi.fn(async () => []),
    } as unknown as Session
    const h = setup({ session })
    h.store.setState('sessionId', 's1')
    h.handler.startSubscription()
    await Promise.resolve()

    const item = { text: '/review src/a.ts', skillName: 'review', skillArgs: 'src/a.ts' }
    h.shiftQueuedMessage.mockReturnValue(item)
    capturedEmit?.({ type: 'compaction.cancelled', sessionId: 's1', agentId: 'main' } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(h.host.sendSkillActivation).toHaveBeenCalledWith(session, 'review', 'src/a.ts')
    expect(h.host.sendQueuedMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tool-progress semantics + card data fidelity
// ---------------------------------------------------------------------------

interface ToolCardHarness {
  h: Harness
  entryId: string
}

/** Seed a live tool-call card: a transcript entry plus the streaming-UI
 *  lookups (`getToolComponent` / `getActiveToolCall`) the handler relies on. */
function setupToolCard(toolName: string, streamingArguments?: string): ToolCardHarness {
  const h = setup()
  const entryId = 'entry-1'
  h.store.setState('transcript', [
    {
      id: entryId,
      kind: 'tool_call',
      renderMode: 'plain',
      content: '',
      toolCallData: { id: 'c1', name: toolName, args: {}, streamingArguments },
    },
  ])
  h.streamingUI.getToolComponent.mockReturnValue(entryId)
  h.streamingUI.getActiveToolCall.mockReturnValue({
    id: 'c1',
    name: toolName,
    args: {},
  } as never)
  return { h, entryId }
}

const cardOf = (h: Harness, entryId: string) =>
  h.store.state.transcript.find((entry) => entry.id === entryId)?.toolCallData

describe('SessionEventHandler tool.progress dispatch', () => {
  // Progress patches coalesce onto a ~50ms timer; tests flush synchronously.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const flushProgress = (): void => {
    vi.advanceTimersByTime(TOOL_PROGRESS_COALESCE_MS + 1)
  }

  it('routes stdout into liveOutput and never into streamingArguments', () => {
    const { h, entryId } = setupToolCard('Bash', '{"command": "l')
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: 'file-a\n' } })
    flushProgress()
    const data = cardOf(h, entryId)
    expect(data?.liveOutput).toBe('file-a\n')
    // Regression: running output used to be appended onto the args preview,
    // polluting the Bash command preview area.
    expect(data?.streamingArguments).toBe('{"command": "l')
    expect(data?.progressLines).toBeUndefined()
  })

  it('coalesces multiple stdout bursts into one transcript patch per interval', () => {
    const { h, entryId } = setupToolCard('Bash')
    const storeSpy = vi.spyOn(h.store, 'setState')
    for (let i = 0; i < 20; i++) {
      handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: `chunk-${String(i)}\n` } })
    }
    flushProgress()
    const data = cardOf(h, entryId)
    expect(data?.liveOutput).toContain('chunk-19\n')
    // 20 events applied as a single patch round instead of twenty.
    const calls = storeSpy.mock.calls as unknown as Array<[string, unknown]>
    const transcriptPatches = calls.filter(([key]) => key === 'transcript').length
    expect(transcriptPatches).toBe(1)
  })

  it('appends stderr chunks to the same live output buffer', () => {
    const { h, entryId } = setupToolCard('Bash')
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: 'out' } })
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stderr', text: 'err' } })
    flushProgress()
    expect(cardOf(h, entryId)?.liveOutput).toBe('outerr')
  })

  it('routes status updates into the progress block with replace support', () => {
    const { h, entryId } = setupToolCard('Bash')
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'status', text: 'step 1\nstill going', replace: true } })
    flushProgress()
    let data = cardOf(h, entryId)
    expect(data?.progressLines).toEqual(['step 1', 'still going'])
    expect(data?.progressStatusRows).toBe(2)

    // A replacing update swaps the previous replaceable rows instead of piling up.
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'status', text: 'step 2', replace: true } })
    flushProgress()
    data = cardOf(h, entryId)
    expect(data?.progressLines).toEqual(['step 2'])
    expect(data?.progressStatusRows).toBe(1)

    // A non-replacing update appends below the replaceable block.
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'status', text: 'done bit' } })
    flushProgress()
    data = cardOf(h, entryId)
    expect(data?.progressLines).toEqual(['step 2', 'done bit'])
    expect(data?.progressStatusRows).toBe(0)
  })

  it('caps progress lines and head-truncates oversized live output', () => {
    const { h, entryId } = setupToolCard('Bash')
    for (let i = 0; i < 30; i++) {
      handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'status', text: `row-${i}` } })
    }
    flushProgress()
    const lines = cardOf(h, entryId)?.progressLines ?? []
    expect(lines).toHaveLength(24)
    expect(lines[0]).toBe('row-6')

    handle(h, {
      type: 'tool.progress',
      toolCallId: 'c1',
      update: { kind: 'stdout', text: 'x'.repeat(50_001) },
    })
    flushProgress()
    expect(cardOf(h, entryId)?.liveOutput?.startsWith('[...truncated]\n')).toBe(true)
  })

  it('marks foreground Bash/Agent cards with the detach hint on progress', () => {
    const bash = setupToolCard('Bash')
    handle(bash.h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'status', text: 'working' } })
    flushProgress()
    expect(cardOf(bash.h, bash.entryId)?.detachHint).toBe(true)

    const agent = setupToolCard('Agent')
    handle(agent.h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: 'chunk' } })
    flushProgress()
    expect(cardOf(agent.h, agent.entryId)?.detachHint).toBe(true)

    const read = setupToolCard('Read')
    handle(read.h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: 'chunk' } })
    flushProgress()
    expect(cardOf(read.h, read.entryId)?.detachHint).toBeUndefined()
  })

  it('ignores progress events for calls without a live card', () => {
    const h = setup()
    handle(h, { type: 'tool.progress', toolCallId: 'c1', update: { kind: 'stdout', text: 'orphan' } })
    expect(h.store.state.transcript).toHaveLength(0)
  })
})

describe('SessionEventHandler todo fidelity', () => {
  it('keeps the TodoList tree fields instead of stripping them', () => {
    const h = setup()
    h.streamingUI.completeToolResult.mockReturnValue({
      id: 'c1',
      name: 'TodoList',
      args: {
        todos: [
          { id: 'm1', kind: 'milestone', title: 'phase', status: 'in_progress', progress: 40 },
          { id: 't1', parentId: 'm1', kind: 'task', title: 'task', status: 'pending', progress: 120 },
          { title: 'legacy flat row', status: 'done' },
          { title: '', status: 'done' },
        ],
      },
    } as never)
    handle(h, { type: 'tool.result', toolCallId: 'c1', output: '', isError: false })
    expect(h.streamingUI.setTodoList).toHaveBeenCalledWith([
      { id: 'm1', parentId: null, kind: 'milestone', title: 'phase', status: 'in_progress', progress: 40 },
      { id: 't1', parentId: 'm1', kind: 'task', title: 'task', status: 'pending', progress: 100 },
      { id: undefined, parentId: null, kind: 'task', title: 'legacy flat row', status: 'done', progress: undefined },
    ])
  })
})

describe('SessionEventHandler bundled skill cards', () => {
  it('inserts a bundled activation before its prompt entry and flags it for undo', () => {
    const h = setup()
    h.host.hasPendingBundledSkill = () => true
    h.host.lastDispatchedUserEntryId = 'u1'
    h.store.setState('transcript', [
      { id: 'before', kind: 'assistant', renderMode: 'markdown', content: 'earlier' },
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'do things' },
    ])

    handle(h, { type: 'skill.activated', activationId: 'sk-1', skillName: 'review', trigger: 'user-slash' })

    const kinds = h.store.state.transcript.map((entry) => entry.kind)
    expect(kinds).toEqual(['assistant', 'skill_activation', 'user'])
    expect(h.store.state.transcript[1]?.bundledWithPrompt).toBe(true)
  })

  it('keeps non-bundled activations appended at the tail without the undo flag', () => {
    const h = setup()
    h.store.setState('transcript', [
      { id: 'u1', kind: 'user', renderMode: 'plain', content: 'do things' },
    ])

    handle(h, { type: 'skill.activated', activationId: 'sk-1', skillName: 'review', trigger: 'model-tool' })

    // Non-bundled activations ride appendTranscriptEntry (the harness captures
    // it separately from the store) and carry no grouping flag.
    expect(h.entries).toHaveLength(1)
    expect(h.entries[0]?.kind).toBe('skill_activation')
    expect(h.entries[0]?.bundledWithPrompt).toBeUndefined()
  })
})

describe('SessionEventHandler agent swarm cancellation', () => {
  it('folds still-running swarm summaries to cancelled when the turn is cancelled', () => {
    const h = setup()
    const swarm = (status: 'streaming' | 'running' | 'ended') => ({
      toolCallId: 'c1',
      description: 'swarm',
      status,
      memberCount: 2,
      completedCount: 0,
      failedCount: 0,
      members: [],
    })
    h.store.setState('transcript', [
      { id: 'a', kind: 'tool_call', renderMode: 'plain', content: '', agentSwarmData: swarm('running') },
      { id: 'b', kind: 'tool_call', renderMode: 'plain', content: '', agentSwarmData: swarm('streaming') },
      { id: 'c', kind: 'tool_call', renderMode: 'plain', content: '', agentSwarmData: swarm('ended') },
      { id: 'd', kind: 'assistant', renderMode: 'markdown', content: 'text' },
    ])

    handle(h, { type: 'turn.ended', turnId: 1, reason: 'cancelled' })

    const statuses = h.store.state.transcript.map((entry) => entry.agentSwarmData?.status)
    expect(statuses).toEqual(['cancelled', 'cancelled', 'ended', undefined])
  })
})
