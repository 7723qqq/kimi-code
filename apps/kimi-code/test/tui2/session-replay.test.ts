/**
 * Tests for `SessionReplayRenderer` — the resume-replay → transcript
 * renderer.
 *
 * The renderer is pure orchestration over the store + streamingUI +
 * sessionEventHandler: it hydrates the app snapshot/todos/background state,
 * replays each record into transcript entries (through `appendTranscriptEntry`
 * and the streamingUI lifecycle), applies terminal background-agent statuses,
 * and cleans up. The host is a fiducial mock (real `Tui2Store`, mocked
 * streamingUI/sessionEventHandler); the renderer under test is the real
 * class.
 */

import { describe, expect, it, vi } from 'vitest'

import type { AgentReplayRecord, ResumedAgentState, Session } from '@moonshot-ai/kimi-code-sdk'

import { SessionReplayRenderer } from '@/tui2/controllers/session-replay'
import type { SessionReplayHost } from '@/tui2/controllers/session-replay'
import type { SessionEventHandler } from '@/tui2/controllers/session-event-handler'
import type { StreamingUIController } from '@/tui2/controllers/streaming-ui'
import { createTui2Store, type Tui2Store } from '@/tui2/state'
import type { TranscriptEntry } from '@/tui2/types'

interface StreamingUIMock {
  setTodoList: ReturnType<typeof vi.fn>
  applyBackgroundTaskTerminalStatus: ReturnType<typeof vi.fn>
  setTurnId: ReturnType<typeof vi.fn>
  setStep: ReturnType<typeof vi.fn>
  setActiveToolCall: ReturnType<typeof vi.fn>
  removeActiveToolCall: ReturnType<typeof vi.fn>
  onToolCallStart: ReturnType<typeof vi.fn>
  onToolCallEnd: ReturnType<typeof vi.fn>
  onThinkingUpdate: ReturnType<typeof vi.fn>
  onThinkingEnd: ReturnType<typeof vi.fn>
  onStreamingTextStart: ReturnType<typeof vi.fn>
  onStreamingTextUpdate: ReturnType<typeof vi.fn>
  onStreamingTextEnd: ReturnType<typeof vi.fn>
  clearAssistantDraft: ReturnType<typeof vi.fn>
  cleanupAfterReplay: ReturnType<typeof vi.fn>
  removeToolComponent: ReturnType<typeof vi.fn>
}

interface Harness {
  readonly renderer: SessionReplayRenderer
  readonly store: Tui2Store
  readonly streamingUI: StreamingUIMock
  readonly sessionEventHandler: SessionEventHandler
  readonly setAppState: ReturnType<typeof vi.fn>
  readonly showError: ReturnType<typeof vi.fn>
  readonly appendTranscriptEntry: ReturnType<typeof vi.fn>
  readonly mergeAllTurnSteps: ReturnType<typeof vi.fn>
  readonly entries: TranscriptEntry[]
}

function setupHarness(): Harness {
  const store = createTui2Store()
  const entries: TranscriptEntry[] = []

  const streamingUI = {
    setTodoList: vi.fn(),
    applyBackgroundTaskTerminalStatus: vi.fn(() => true),
    setTurnId: vi.fn(),
    setStep: vi.fn(),
    setActiveToolCall: vi.fn(),
    removeActiveToolCall: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onThinkingUpdate: vi.fn(),
    onThinkingEnd: vi.fn(),
    onStreamingTextStart: vi.fn(),
    onStreamingTextUpdate: vi.fn(),
    onStreamingTextEnd: vi.fn(),
    clearAssistantDraft: vi.fn(),
    cleanupAfterReplay: vi.fn(),
    removeToolComponent: vi.fn(),
  }

  const subAgentEventHandler = {
    backgroundAgentMetadata: new Map(),
    activityStore: { get: vi.fn() },
  }
  const sessionEventHandler = {
    subAgentEventHandler,
    backgroundTasks: new Map(),
    backgroundTaskTranscriptedTerminal: new Set<string>(),
    renderedSkillActivationIds: new Set<string>(),
    renderedPluginCommandActivationIds: new Set<string>(),
  } as unknown as SessionEventHandler

  const setAppState = vi.fn()
  const showError = vi.fn()
  const appendTranscriptEntry = vi.fn((entry: TranscriptEntry) => {
    entries.push(entry)
  })
  const mergeAllTurnSteps = vi.fn()

  const host: SessionReplayHost = {
    store,
    streamingUI: streamingUI as unknown as StreamingUIController,
    sessionEventHandler,
    setAppState,
    showError,
    appendTranscriptEntry,
    mergeAllTurnSteps,
  }

  const renderer = new SessionReplayRenderer(host)
  return { renderer, store, streamingUI, sessionEventHandler, setAppState, showError, appendTranscriptEntry, mergeAllTurnSteps, entries }
}

function makeMainAgent(
  replay: readonly AgentReplayRecord[] = [],
  extra: Record<string, unknown> = {},
): ResumedAgentState {
  return {
    type: 'main',
    config: { cwd: '/ws', modelCapabilities: undefined, thinkingEffort: 'off', systemPrompt: '' },
    context: { history: [], tokenCount: 0 },
    replay,
    permission: { mode: 'manual' },
    plan: {},
    usage: {},
    tools: [],
    background: [],
    ...extra,
  } as unknown as ResumedAgentState
}

function sessionWith(main: ResumedAgentState): Session {
  return { getResumeState: () => ({ agents: { main } }) } as unknown as Session
}

function userMessage(text: string, origin?: Record<string, unknown>): AgentReplayRecord {
  return {
    time: 1,
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }], origin },
  } as unknown as AgentReplayRecord
}

describe('SessionReplayRenderer.hydrateFromReplay', () => {
  it('reports an error and returns false when the main agent is missing', async () => {
    const h = setupHarness()
    const session = { getResumeState: () => ({ agents: {} }) } as unknown as Session

    const ok = await h.renderer.hydrateFromReplay(session)

    expect(ok).toBe(false)
    expect(h.showError).toHaveBeenCalled()
  })

  it('reports an error and returns false when resume state throws', async () => {
    const h = setupHarness()
    const session = {
      getResumeState: () => {
        throw new Error('boom')
      },
    } as unknown as Session

    const ok = await h.renderer.hydrateFromReplay(session)

    expect(ok).toBe(false)
    expect(h.showError).toHaveBeenCalled()
  })

  it('renders user, assistant, tool call, and tool result into the host', async () => {
    const h = setupHarness()
    const main = makeMainAgent([
      userMessage('hello'),
      { time: 2, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] } } as AgentReplayRecord,
      {
        time: 3,
        type: 'message',
        message: { role: 'assistant', content: [], toolCalls: [{ id: 'call-1', name: 'Bash', arguments: { command: 'ls' } }] },
      } as unknown as AgentReplayRecord,
      { time: 4, type: 'message', message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'out' }] } } as unknown as AgentReplayRecord,
    ])

    const ok = await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(ok).toBe(true)
    expect(h.entries.some((entry) => entry.kind === 'user')).toBe(true)
    expect(h.streamingUI.onStreamingTextUpdate).toHaveBeenCalledWith('hi')
    expect(h.streamingUI.onToolCallStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call-1', name: 'Bash' }),
    )
    expect(h.streamingUI.onToolCallEnd).toHaveBeenCalledWith(
      'call-1',
      expect.objectContaining({ output: 'out' }),
    )
    expect(h.mergeAllTurnSteps).toHaveBeenCalled()
  })

  it('toggles isReplaying around the whole hydration', async () => {
    const h = setupHarness()
    const ok = await h.renderer.hydrateFromReplay(sessionWith(makeMainAgent([userMessage('hi')])))

    expect(ok).toBe(true)
    const patches = h.setAppState.mock.calls.map((call) => call[0] as Record<string, unknown>)
    expect(patches[0]).toMatchObject({ isReplaying: true })
    expect(patches.at(-1)).toMatchObject({ isReplaying: false })
  })

  it('renders a plan_updated notice as a status entry', async () => {
    const h = setupHarness()
    const main = makeMainAgent([{ time: 1, type: 'plan_updated', enabled: true } as AgentReplayRecord])

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.entries.some((entry) => entry.kind === 'status')).toBe(true)
  })

  it('renders a permission_updated yolo mode as a status entry', async () => {
    const h = setupHarness()
    const main = makeMainAgent([{ time: 1, type: 'permission_updated', mode: 'yolo' } as AgentReplayRecord])

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.entries.some((entry) => entry.kind === 'status')).toBe(true)
  })

  it('renders a goal_updated created as a goal entry', async () => {
    const h = setupHarness()
    const main = makeMainAgent([
      { time: 1, type: 'goal_updated', snapshot: {} as never, change: { kind: 'created' } } as AgentReplayRecord,
    ])

    await h.renderer.hydrateFromReplay(sessionWith(main))

    const goal = h.entries.find((entry) => entry.kind === 'goal')
    expect(goal?.goalData).toEqual({ kind: 'created' })
  })

  it('renders a skill activation once and dedupes repeats', async () => {
    const h = setupHarness()
    const main = makeMainAgent([
      userMessage('', { kind: 'skill_activation', activationId: 'sk-1', skillName: 'web', trigger: 'user-slash' }),
      userMessage('', { kind: 'skill_activation', activationId: 'sk-1', skillName: 'web', trigger: 'user-slash' }),
    ])

    await h.renderer.hydrateFromReplay(sessionWith(main))

    const skills = h.entries.filter((entry) => entry.kind === 'skill_activation')
    expect(skills).toHaveLength(1)
    expect(skills[0]?.skillActivationId).toBe('sk-1')
  })

  it('renders a shell command input as a `$ cmd` user entry', async () => {
    const h = setupHarness()
    const main = makeMainAgent([
      userMessage('<bash-input>ls -la</bash-input>', { kind: 'shell_command', phase: 'input' }),
    ])

    await h.renderer.hydrateFromReplay(sessionWith(main))

    const user = h.entries.find((entry) => entry.kind === 'user')
    expect(user?.content).toContain('$ ls -la')
  })
})

describe('SessionReplayRenderer snapshot hydration', () => {
  it('hydrates the todo list from the tool store', async () => {
    const h = setupHarness()
    const main = makeMainAgent([], {
      toolStore: {
        todo: [
          { title: 'task a', status: 'pending' },
          { title: 'task b', status: 'done' },
        ],
      },
    })

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.streamingUI.setTodoList).toHaveBeenCalledWith([
      { title: 'task a', status: 'pending' },
      { title: 'task b', status: 'done' },
    ])
  })

  it('clears the todo list when every todo is done', async () => {
    const h = setupHarness()
    const main = makeMainAgent([], {
      toolStore: { todo: [{ title: 'done', status: 'done' }] },
    })

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.streamingUI.setTodoList).toHaveBeenCalledWith([])
  })

  it('hydrates background tasks, metadata, and counts', async () => {
    const h = setupHarness()
    const main = makeMainAgent([], {
      background: [
        {
          taskId: 'task-1',
          kind: 'agent',
          agentId: 'child-1',
          description: 'bg work',
          status: 'running',
          startedAt: new Date(0),
        },
        {
          taskId: 'task-2',
          kind: 'agent',
          agentId: 'child-2',
          description: 'done work',
          status: 'completed',
          startedAt: new Date(0),
        },
      ],
    })

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.sessionEventHandler.backgroundTasks.size).toBe(2)
    expect(h.sessionEventHandler.backgroundTaskTranscriptedTerminal.has('task-2')).toBe(true)
    // Running agent stays in the metadata projection; terminal one is pruned.
    expect(h.sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.has('child-1')).toBe(true)
    expect(h.store.state.backgroundCounts).toEqual({ bashTasks: 0, agentTasks: 1 })
  })

  it('applies terminal status to replayed background agent cards', async () => {
    const h = setupHarness()
    const main = makeMainAgent([], {
      background: [
        {
          taskId: 'task-1',
          kind: 'agent',
          agentId: 'child-1',
          description: 'bg work',
          status: 'failed',
          startedAt: new Date(0),
        },
      ],
    })

    await h.renderer.hydrateFromReplay(sessionWith(main))

    expect(h.streamingUI.applyBackgroundTaskTerminalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'child-1', status: 'failed' }),
    )
  })
})
