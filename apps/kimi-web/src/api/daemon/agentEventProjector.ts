// apps/kimi-web/src/api/daemon/agentEventProjector.ts
//
// Client-side projector: raw agent-core WS events → AppEvent[]
//
// The real daemon pushes raw agent-core events (NOT the projected "event.*"
// protocol events). This projector translates them into the same AppEvent union
// that the existing reducer (eventReducer.ts) consumes.
//
// Ported from the daemon-side reference implementation:
//   apps/kimi-daemon/src/session/event-projector.ts
//   apps/kimi-daemon/src/session/message-log.ts
//   apps/kimi-daemon/src/session/usage-tracker.ts
//
// Usage:
//   const projector = createAgentProjector();
//   const appEvents = projector.project(rawType, payload, sessionId);
//   // call reset() when re-subscribing / resyncing a session

import type { AppEvent, AppInFlightTurn, AppMessage, AppMessageContent, AppSessionUsage } from '../types';
import { i18n } from '../../i18n';
import { toAppMessageContent } from './mappers';
import type { WireMessageContent } from './wire';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ulid(prefix = 'msg_'): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${r}`;
}

/** Normalise the raw token usage shape emitted by agent-core. */
function normalizeUsage(raw: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }
  const u = raw as Record<string, number | undefined>;
  return {
    input: u['inputOther'] ?? u['input_tokens'] ?? 0,
    output: u['output'] ?? u['output_tokens'] ?? 0,
    cacheRead: u['inputCacheRead'] ?? u['cache_read_input_tokens'] ?? 0,
    cacheCreate: u['inputCacheCreation'] ?? u['cache_creation_input_tokens'] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-session projector state
// ---------------------------------------------------------------------------

interface SessionState {
  // Turn ID → promptId binding
  turnPromptId: Map<number, string>;
  currentPromptId: string | undefined;

  // Assistant message tracking
  currentAssistantMsgId: string | undefined;

  // Per-turn accumulated stream lengths — aligned against the wire `offset`
  // on volatile delta frames (v2 sync protocol) to skip duplicates and
  // detect gaps after a snapshot seed.
  turnTextLen: number;
  turnThinkLen: number;

  // Tool timing
  toolStartTimes: Map<string, number>;

  // Usage accumulator
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  contextTokens: number;
  contextLimit: number;
  turnCount: number;
  model: string;

  // In-memory message log (mirrors daemon message-log.ts)
  messages: AppMessage[];
}

function createSessionState(): SessionState {
  return {
    turnPromptId: new Map(),
    currentPromptId: undefined,
    currentAssistantMsgId: undefined,
    turnTextLen: 0,
    turnThinkLen: 0,
    toolStartTimes: new Map(),
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    contextTokens: 0,
    contextLimit: 0,
    turnCount: 0,
    model: '',
    messages: [],
  };
}

// ---------------------------------------------------------------------------
// Message-log helpers (inlined; mirrors message-log.ts)
// ---------------------------------------------------------------------------

/**
 * Decouple an emitted message from the projector's internal log. The reducer
 * stores emitted messages by reference; the projector keeps mutating its own
 * copy in place (`slot.text += delta`), so sharing the content objects makes
 * the reducer's delta-append run on already-appended text — the first streamed
 * chunk of every text/thinking block rendered twice.
 */
function cloneMessage(msg: AppMessage): AppMessage {
  return { ...msg, content: msg.content.map((c) => ({ ...c })) };
}

function startAssistantMessage(state: SessionState, sessionId: string, promptId: string): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'assistant',
    content: [],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function startUserMessage(
  state: SessionState,
  sessionId: string,
  promptId: string,
  userMessageId: string,
  content: AppMessageContent[],
  createdAt: string,
): AppMessage {
  const msg: AppMessage = {
    id: userMessageId,
    sessionId,
    role: 'user',
    content,
    createdAt,
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function toAppPromptContent(raw: unknown): AppMessageContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((part) => toAppMessageContent(part as WireMessageContent));
}

/**
 * Append a streamed text/thinking delta in stream order: continue the LAST
 * content part when it has the same type, otherwise open a NEW part at the
 * end. Returns the content index written (-1 if the message is unknown) so
 * the emitted assistantDelta targets the same slot in the reducer.
 *
 * No per-type fixed slots: a step that goes think → text → think again gets
 * three parts in call order instead of all thinking collapsing into one slot.
 */
function appendAssistantDelta(
  state: SessionState,
  messageId: string,
  kind: 'text' | 'thinking',
  delta: string,
): number {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return -1;
  const last = msg.content[msg.content.length - 1];
  if (last && last.type === kind) {
    if (kind === 'text') (last as { type: 'text'; text: string }).text += delta;
    else (last as { type: 'thinking'; thinking: string }).thinking += delta;
    return msg.content.length - 1;
  }
  msg.content.push(kind === 'text' ? { type: 'text', text: delta } : { type: 'thinking', thinking: delta });
  return msg.content.length - 1;
}

function appendToolUse(
  state: SessionState,
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
): void {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.content.push({ type: 'toolUse', toolCallId, toolName, input });
}

function finishAssistantMessage(state: SessionState, messageId: string): void {
  const msg = state.messages.find((m) => m.id === messageId);
  // We record nothing extra here — status is implicit in the downstream reducer
  void msg;
}

function appendToolResultMessage(
  state: SessionState,
  sessionId: string,
  toolCallId: string,
  output: unknown,
  isError: boolean,
  promptId: string,
): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'tool',
    content: [{ type: 'toolResult', toolCallId, output, isError }],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function getMsgById(state: SessionState, messageId: string): AppMessage | undefined {
  return state.messages.find((m) => m.id === messageId);
}

// ---------------------------------------------------------------------------
// Usage snapshot builder
// ---------------------------------------------------------------------------

function buildUsageSnapshot(state: SessionState): AppSessionUsage {
  return {
    inputTokens: state.totalInput,
    outputTokens: state.totalOutput,
    cacheReadTokens: state.totalCacheRead,
    cacheCreationTokens: state.totalCacheCreate,
    totalCostUsd: 0,
    contextTokens: state.contextTokens,
    contextLimit: state.contextLimit,
    turnCount: state.turnCount,
  };
}

// ---------------------------------------------------------------------------
// AgentProjector
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  /**
   * Wire-level pre-append stream offset on volatile text-delta frames (v2
   * sync protocol). Used to skip duplicate deltas and detect gaps after a
   * snapshot seed.
   */
  offset?: number;
}

export interface AgentProjector {
  /** Project a single raw agent-core event into zero or more AppEvents. Never throws. */
  project(rawType: string, payload: unknown, sessionId: string, meta?: ProjectMeta): AppEvent[];
  /**
   * Bind an externally-known promptId to the next turn.startd for this session.
   * Call this right after submitPrompt() returns, before the first turn.started arrives.
   */
  bindNextPromptId(sessionId: string, promptId: string): void;
  /**
   * Seed mid-turn state from a session snapshot's `in_flight_turn` (v2 sync):
   * resets per-session state, builds the partially-streamed assistant message
   * (thinking + text + running tool_use parts), and returns the AppEvents
   * (sessionStatusChanged + messageCreated) to apply to the reducer. Live
   * deltas continue appending; their wire `offset` aligns against the seeded
   * text so the overlap window around snapshot/subscribe is exact.
   */
  seedInFlight(sessionId: string, turn: AppInFlightTurn): AppEvent[];
  /** Reset all per-session state (call on re-subscribe / resync). */
  reset(sessionId: string): void;
}

export function createAgentProjector(): AgentProjector {
  const sessions = new Map<string, SessionState>();

  function getOrCreate(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = createSessionState();
      sessions.set(sessionId, s);
    }
    return s;
  }

  function reset(sessionId: string): void {
    sessions.set(sessionId, createSessionState());
  }

  function bindNextPromptId(sessionId: string, promptId: string): void {
    const s = getOrCreate(sessionId);
    s.currentPromptId = promptId;
  }

  function seedInFlight(sessionId: string, turn: AppInFlightTurn): AppEvent[] {
    reset(sessionId);
    const s = getOrCreate(sessionId);

    const promptId = ulid('pr_');
    s.currentPromptId = promptId;
    s.turnPromptId.set(turn.turnId, promptId);

    const msg = startAssistantMessage(s, sessionId, promptId);
    if (turn.thinkingText.length > 0) {
      msg.content.push({ type: 'thinking', thinking: turn.thinkingText });
    }
    if (turn.assistantText.length > 0) {
      msg.content.push({ type: 'text', text: turn.assistantText });
    }
    for (const tool of turn.runningTools) {
      msg.content.push({
        type: 'toolUse',
        toolCallId: tool.toolCallId,
        toolName: tool.name,
        input: tool.args ?? {},
      });
      s.toolStartTimes.set(tool.toolCallId, Date.now());
    }
    s.currentAssistantMsgId = msg.id;
    s.turnTextLen = turn.assistantText.length;
    s.turnThinkLen = turn.thinkingText.length;

    return [
      {
        type: 'sessionStatusChanged',
        sessionId,
        status: 'running',
        previousStatus: 'idle',
        currentPromptId: promptId,
      },
      { type: 'messageCreated', message: cloneMessage(msg) },
    ];
  }

  function project(
    rawType: string,
    payload: unknown,
    sessionId: string,
    meta?: ProjectMeta,
  ): AppEvent[] {
    try {
      return _project(rawType, payload, sessionId, meta);
    } catch (err) {
      // Defensive: log but never crash the caller
      console.error('[agentProjector] Error projecting event:', rawType, err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Align a live text-delta against the per-turn accumulated length using the
   * wire `offset`. Returns 'skip' for duplicates (offset behind local state),
   * 'gap' when deltas were missed (offset ahead — trigger a re-snapshot), and
   * 'append' otherwise.
   */
  function alignDelta(localLen: number, offset: number | undefined): 'append' | 'skip' | 'gap' {
    if (offset === undefined) return 'append';
    if (offset < localLen) return 'skip';
    if (offset > localLen) return 'gap';
    return 'append';
  }

  function _project(
    rawType: string,
    payload: unknown,
    sessionId: string,
    meta?: ProjectMeta,
  ): AppEvent[] {
    const s = getOrCreate(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    const out: AppEvent[] = [];

    switch (rawType) {
      // -----------------------------------------------------------------------
      case 'session.meta.updated': {
        // The daemon auto-generates a title from the first prompt (and other
        // clients can rename a session). It announces both via this event. We
        // don't have the full AppSession here, so emit a lightweight
        // sessionMetaUpdated that patches only the title field.
        const title: string | undefined = p?.patch?.title ?? p?.title;
        if (typeof title === 'string' && title.length > 0) {
          out.push({ type: 'sessionMetaUpdated', sessionId, title });
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'prompt.submitted': {
        const promptId: string | undefined = p?.promptId;
        const userMessageId: string | undefined = p?.userMessageId;
        if (!promptId || !userMessageId) break;
        const content = toAppPromptContent(p?.content);
        if (content.length === 0) break;
        s.currentPromptId = promptId;
        const msg = startUserMessage(
          s,
          sessionId,
          promptId,
          userMessageId,
          content,
          typeof p?.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
        );
        out.push({ type: 'messageCreated', message: cloneMessage(msg) });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.started': {
        // Bind turnId → promptId. Generate a synthetic one if none was pre-bound.
        const turnId: number = p?.turnId;
        const existingPromptId = s.currentPromptId ?? ulid('pr_');
        s.currentPromptId = existingPromptId;
        if (turnId !== undefined) {
          s.turnPromptId.set(turnId, existingPromptId);
        }
        // Fresh turn → fresh per-turn stream offsets.
        s.turnTextLen = 0;
        s.turnThinkLen = 0;

        out.push({
          type: 'sessionStatusChanged',
          sessionId,
          status: 'running',
          previousStatus: 'idle',
          currentPromptId: existingPromptId,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.started': {
        const turnId: number = p?.turnId;
        let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!promptId) {
          // Joined mid-turn (reconnect/resync wiped the binding): synthesize a
          // promptId like turn.started does, so the REST of the turn still
          // renders instead of every following event being dropped.
          promptId = ulid('pr_');
          s.currentPromptId = promptId;
          if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
        }

        // Create a new pending assistant message
        const msg = startAssistantMessage(s, sessionId, promptId);
        s.currentAssistantMsgId = msg.id;

        out.push({ type: 'messageCreated', message: cloneMessage(msg) });
        break;
      }

      // -----------------------------------------------------------------------
      case 'thinking.delta': {
        const msgId = s.currentAssistantMsgId;
        if (!msgId) break;
        const delta: string = p?.delta ?? '';
        if (!delta) break;

        // Same missed-turn-boundary self-heal as assistant.delta (see there).
        if (meta?.offset === 0 && s.turnThinkLen > 0) {
          s.turnThinkLen = 0;
        }

        const align = alignDelta(s.turnThinkLen, meta?.offset);
        if (align === 'skip') break;
        if (align === 'gap') {
          out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
          break;
        }

        const thinkIdx = appendAssistantDelta(s, msgId, 'thinking', delta);
        if (thinkIdx < 0) break;
        s.turnThinkLen += delta.length;
        out.push({
          type: 'assistantDelta',
          sessionId,
          messageId: msgId,
          contentIndex: thinkIdx,
          delta: { thinking: delta },
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'assistant.delta': {
        const msgId = s.currentAssistantMsgId;
        if (!msgId) break;
        const delta: string = p?.delta ?? '';
        if (!delta) break;

        // Self-heal a missed turn boundary: a pre-append offset of 0 while we
        // still believe we are mid-stream means the daemon began a fresh
        // assistant stream (new turn / retry) whose turn.started we never saw —
        // e.g. the durable replay and the live volatile deltas raced on the
        // cursor after a reconnect. Without this reset every delta has
        // offset < turnTextLen and is SILENTLY skipped forever (skip, unlike
        // gap, never recovers), so streaming dies until a full page reload.
        if (meta?.offset === 0 && s.turnTextLen > 0) {
          s.turnTextLen = 0;
        }

        const align = alignDelta(s.turnTextLen, meta?.offset);
        if (align === 'skip') break;
        if (align === 'gap') {
          // Deltas were missed in the snapshot↔subscribe window — the only
          // exact recovery is a fresh snapshot. historyCompacted is routed to
          // onResync by the client wrapper, which reloads via snapshot.
          out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
          break;
        }

        const textIdx = appendAssistantDelta(s, msgId, 'text', delta);
        if (textIdx < 0) break;
        s.turnTextLen += delta.length;
        out.push({
          type: 'assistantDelta',
          sessionId,
          messageId: msgId,
          contentIndex: textIdx,
          delta: { text: delta },
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.use':
      case 'tool.call.started': {
        const msgId = s.currentAssistantMsgId;
        const turnId: number = p?.turnId;
        const promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!msgId || !promptId) break;

        const toolCallId: string = p?.toolCallId;
        // Real daemon field name is 'name' per event-projector.ts
        const toolName: string = p?.name ?? p?.toolName ?? '';
        const args = p?.args ?? p?.input ?? {};

        appendToolUse(s, msgId, toolCallId, toolName, args);

        const msg = getMsgById(s, msgId);
        const contentIndex = msg ? msg.content.length - 1 : 0;

        // Record start time
        s.toolStartTimes.set(toolCallId, Date.now());

        // Emit messageUpdated so the reducer knows about the new tool-use slot
        if (msg) {
          out.push({
            type: 'messageUpdated',
            sessionId,
            messageId: msgId,
            content: msg.content.map((c) => ({ ...c })),
            status: 'pending',
          });
        }
        void contentIndex;
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.call.delta': {
        // Input streaming — no-op for the web client (content already in tool.call.started.args)
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.progress': {
        // No-op — tool output streaming is not rendered at the AppEvent level
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.result': {
        const turnId: number = p?.turnId;
        let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!promptId) {
          // Same mid-turn-join fallback as turn.step.started.
          promptId = ulid('pr_');
          s.currentPromptId = promptId;
          if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
        }

        const toolCallId: string = p?.toolCallId;
        const output = p?.output;
        const isError: boolean = p?.isError ?? false;

        const startTime = s.toolStartTimes.get(toolCallId) ?? Date.now();
        s.toolStartTimes.delete(toolCallId);
        void (Date.now() - startTime); // duration — unused at client level

        const resultMsg = appendToolResultMessage(s, sessionId, toolCallId, output, isError, promptId);
        out.push({ type: 'messageCreated', message: cloneMessage(resultMsg) });

        // Reset assistant message tracking — next step.started will create a fresh one
        s.currentAssistantMsgId = undefined;
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.completed': {
        const msgId = s.currentAssistantMsgId;

        // Feed usage
        const u = normalizeUsage(p?.usage);
        s.totalInput += u.input;
        s.totalOutput += u.output;
        s.totalCacheRead += u.cacheRead;
        s.totalCacheCreate += u.cacheCreate;

        if (msgId) {
          finishAssistantMessage(s, msgId);
          const msg = getMsgById(s, msgId);
          if (msg) {
            out.push({
              type: 'messageUpdated',
              sessionId,
              messageId: msgId,
              content: msg.content.map((c) => ({ ...c })),
              status: 'completed',
            });
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'agent.status.updated': {
        if (p?.model) s.model = p.model;
        if (p?.contextTokens !== undefined) s.contextTokens = p.contextTokens;
        if (p?.maxContextTokens !== undefined) s.contextLimit = p.maxContextTokens;

        out.push({
          type: 'sessionUsageUpdated',
          sessionId,
          usage: buildUsageSnapshot(s),
          // Carry the live model so the status bar shows the real running model
          // instead of falling back to the daemon's (empty) REST model.
          model: s.model || undefined,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.ended': {
        const msgId = s.currentAssistantMsgId;
        const reason: string = p?.reason ?? 'completed';

        if (msgId) {
          finishAssistantMessage(s, msgId);
          const msg = getMsgById(s, msgId);
          if (msg) {
            out.push({
              type: 'messageUpdated',
              sessionId,
              messageId: msgId,
              content: msg.content.map((c) => ({ ...c })),
              status: reason === 'failed' ? 'error' : 'completed',
            });
          }
        }

        s.turnCount++;
        const usageSnapshot = buildUsageSnapshot(s);
        out.push({ type: 'sessionUsageUpdated', sessionId, usage: usageSnapshot });

        const newStatus = reason === 'cancelled' ? 'aborted' : reason === 'failed' ? 'aborted' : 'idle';
        out.push({
          type: 'sessionStatusChanged',
          sessionId,
          status: newStatus,
          previousStatus: 'running',
        });

        // Clear per-turn state. Reset the stream offsets too so a stale length
        // from this turn can't wedge the next turn's delta alignment into a
        // silent skip if its turn.started is missed across a reconnect.
        s.currentAssistantMsgId = undefined;
        s.currentPromptId = undefined;
        s.turnTextLen = 0;
        s.turnThinkLen = 0;
        break;
      }

      // -----------------------------------------------------------------------
      case 'prompt.completed': {
        // No-op at AppEvent level — turn.ended already handles the transition to idle
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.retrying':
      case 'turn.step.interrupted': {
        // Discard current assistant message; next step.started will create a new one
        s.currentAssistantMsgId = undefined;
        break;
      }

      // -----------------------------------------------------------------------
      case 'subagent.spawned': {
        out.push({
          type: 'taskCreated',
          sessionId,
          task: {
            id: p?.subagentId ?? ulid('task_'),
            sessionId,
            kind: 'subagent',
            description: p?.subagentName ?? 'subagent',
            status: 'running',
            createdAt: new Date().toISOString(),
          },
        });
        break;
      }

      case 'subagent.completed': {
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId: p?.subagentId ?? '',
          status: 'completed',
          outputPreview: typeof p?.resultSummary === 'string' ? p.resultSummary : undefined,
        });
        break;
      }

      case 'subagent.failed': {
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId: p?.subagentId ?? '',
          status: 'failed',
          outputPreview: typeof p?.error === 'string' ? p.error : undefined,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'error': {
        // Fold into an unknown event so the reducer pushes a warning string
        out.push({
          type: 'unknown',
          raw: { _agentError: true, code: p?.code, message: p?.message },
        });
        break;
      }

      case 'warning': {
        out.push({
          type: 'unknown',
          raw: { _agentWarning: true, message: p?.message },
        });
        break;
      }

      // -----------------------------------------------------------------------
      // Background tasks (e.g. a backgrounded Bash command). Real daemon shape:
      // payload.info = { taskId, description, status, startedAt(ms), endedAt,
      // kind:'process', command, pid, exitCode }.
      case 'background.task.started': {
        const info = (p?.info ?? {}) as Record<string, unknown>;
        const startedAt =
          typeof info.startedAt === 'number' ? new Date(info.startedAt).toISOString() : undefined;
        const taskId =
          typeof info.taskId === 'string'
            ? info.taskId
            : typeof info.taskId === 'number'
              ? String(info.taskId)
              : ulid('task_');
        const description =
          typeof info.description === 'string'
            ? info.description
            : typeof info.command === 'string'
              ? info.command
              : i18n.global.t('tasks.defaultDescription');
        out.push({
          type: 'taskCreated',
          sessionId,
          task: {
            id: taskId,
            sessionId,
            kind: 'bash',
            description,
            status: 'running',
            createdAt: startedAt ?? new Date().toISOString(),
            startedAt,
            outputPreview: typeof info.command === 'string' ? `$ ${info.command}` : undefined,
          },
        });
        break;
      }
      case 'background.task.terminated': {
        const info = (p?.info ?? {}) as Record<string, unknown>;
        const failed =
          info.status === 'failed' ||
          (typeof info.exitCode === 'number' && info.exitCode !== 0);
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId:
            typeof info.taskId === 'string'
              ? info.taskId
              : typeof info.taskId === 'number'
                ? String(info.taskId)
                : '',
          status: failed ? 'failed' : 'completed',
          outputPreview: typeof info.command === 'string' ? `$ ${info.command}` : undefined,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'compaction.completed': {
        // Compaction replaced a batch of old messages with a summary on the
        // daemon side. The visible transcript is NOT reloaded (the client keeps
        // the scrollback and the reducer appends a divider marker); the
        // historyCompacted signal still fires so seq bookkeeping and any
        // non-compaction consumers stay correct.
        const result = (p?.result ?? {}) as Record<string, unknown>;
        out.push({
          type: 'compactionCompleted',
          sessionId,
          tokensBefore: typeof result.tokensBefore === 'number' ? result.tokensBefore : undefined,
          tokensAfter: typeof result.tokensAfter === 'number' ? result.tokensAfter : undefined,
          summary: typeof result.summary === 'string' ? result.summary : undefined,
        });
        out.push({
          type: 'historyCompacted',
          sessionId,
          beforeSeq: 0,
          reason: 'auto_compact',
        });
        break;
      }

      case 'compaction.started': {
        out.push({
          type: 'compactionStarted',
          sessionId,
          trigger: p?.trigger === 'manual' ? 'manual' : 'auto',
          instruction: typeof p?.instruction === 'string' ? p.instruction : undefined,
        });
        break;
      }

      case 'compaction.cancelled': {
        out.push({ type: 'compactionCancelled', sessionId });
        break;
      }

      // -----------------------------------------------------------------------
      // Explicitly known but not projected
      case 'compaction.blocked':
      case 'cron.fired':
      case 'goal.updated':
      case 'hook.result':
      case 'mcp.server.status':
      case 'skill.activated':
      case 'tool.list.updated':
        break;

      // -----------------------------------------------------------------------
      default:
        // Unknown future events — safe no-op
        break;
    }

    return out;
  }

  return { project, bindNextPromptId, seedInFlight, reset };
}

// ---------------------------------------------------------------------------
// Helpers for integration layer
// ---------------------------------------------------------------------------

/**
 * Detect whether an incoming WS frame type is a raw agent-core event
 * (as opposed to a projected "event.*" protocol event or a control frame).
 *
 * Raw agent-core events do NOT start with "event." and are not control frames.
 * Control frames: server_hello, ack, ping, resync_required, error.
 */
const CONTROL_FRAME_TYPES = new Set([
  'server_hello',
  'ack',
  'ping',
  'resync_required',
  'error',
  'pong',
]);

export function isRawAgentCoreEvent(frameType: string): boolean {
  if (frameType.startsWith('event.')) return false;
  if (CONTROL_FRAME_TYPES.has(frameType)) return false;
  return true;
}

/**
 * Agent-core event names the projector knows how to project. These are the
 * raw events the real daemon emits. The same names may arrive WITH an "event."
 * prefix (newer daemon) or WITHOUT it (older daemon).
 */
const KNOWN_AGENT_CORE_TYPES = new Set([
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.ended',
  'thinking.delta',
  'assistant.delta',
  'tool.call.started',
  'tool.use', // alias the daemon may use for tool.call.started
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'agent.status.updated',
  'prompt.submitted',
  'prompt.completed',
  'session.meta.updated',
  'compaction.started',
  'compaction.completed',
  'compaction.cancelled',
  'error',
  'warning',
  'subagent.spawned',
  'subagent.completed',
  'subagent.failed',
  'background.task.started',
  'background.task.terminated',
]);

/**
 * "event."-prefixed names that are GENUINE protocol events (control/projected
 * events produced server-side). The agent projector must NOT re-handle these —
 * they go through the existing toAppEvent() path. This includes approval /
 * question requests (which drive the approval/question UI) and the no-op-but-
 * known streaming/tool protocol events.
 */
const PROTOCOL_EVENT_NAMES = new Set([
  // Session lifecycle (projected)
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status_changed',
  'session.usage_updated',
  'session.history_compacted',
  // Message lifecycle (projected)
  'message.created',
  'message.updated',
  // Approval / Question — MUST stay on the protocol path to drive the UI
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'question.requested',
  'question.answered',
  'question.dismissed',
  'question.expired',
  // Background tasks (projected)
  'task.created',
  'task.progress',
  'task.completed',
  // No-op-but-known protocol streaming / tool events
  'assistant.tool_use_started',
  'assistant.tool_use_delta',
  'assistant.tool_use_completed',
  'assistant.completed',
  'tool.started',
  'tool.output',
  'tool.completed',
]);

/**
 * Names that are ambiguous between the raw agent-core form (payload.delta is a
 * STRING) and the already-projected protocol form (payload.delta is an object
 * { text? | thinking? }, or the payload carries message_id / content_index).
 */
const AMBIGUOUS_DELTA_NAMES = new Set(['assistant.delta', 'thinking.delta']);

export type FrameRoute =
  | { route: 'protocol' }
  | { route: 'agent'; agentType: string }
  | { route: 'ignore' };

/**
 * Classify a (possibly "event."-prefixed) WS frame into the path it should take.
 *
 * - 'protocol' → hand the original frame to toAppEvent() (existing path).
 * - 'agent'    → hand `agentType` + payload to the agent projector.
 * - 'ignore'   → drop (no session context / unroutable).
 *
 * Robust to all three observed shapes:
 *   1) raw agent-core (no prefix):        turn.started, assistant.delta{delta:'…'}
 *   2) "event."-prefixed agent-core:      event.turn.started, event.assistant.delta{delta:'…'}
 *   3) genuine protocol "event.*" events: event.message.created, event.session.*, …
 */
export function classifyFrame(rawType: string, payload: unknown): FrameRoute {
  if (CONTROL_FRAME_TYPES.has(rawType)) return { route: 'ignore' };

  const hasPrefix = rawType.startsWith('event.');
  const name = hasPrefix ? rawType.slice('event.'.length) : rawType;

  // Ambiguous delta events: disambiguate by payload shape regardless of prefix.
  if (AMBIGUOUS_DELTA_NAMES.has(name)) {
    if (deltaIsRawAgentCore(payload)) return { route: 'agent', agentType: name };
    // Object delta or protocol-shaped payload → projected protocol event.
    return { route: 'protocol' };
  }

  // Unprefixed frames are raw agent-core (real daemon) when we know the name.
  if (!hasPrefix) {
    if (KNOWN_AGENT_CORE_TYPES.has(name)) return { route: 'agent', agentType: name };
    // Unknown unprefixed name with no protocol meaning → still try the projector
    // (it safely no-ops on unknown types and advances nothing).
    return { route: 'agent', agentType: name };
  }

  // Prefixed frames: genuine protocol events take priority.
  if (PROTOCOL_EVENT_NAMES.has(name)) return { route: 'protocol' };
  // Prefixed agent-core event (e.g. event.turn.started) → strip + project.
  if (KNOWN_AGENT_CORE_TYPES.has(name)) return { route: 'agent', agentType: name };
  // Unknown "event.*" → let toAppEvent() record it as an unknown protocol event.
  return { route: 'protocol' };
}

/**
 * True when an assistant.delta / thinking.delta payload is in the RAW agent-core
 * form: payload.delta is a plain string, and there is no protocol-only field
 * (message_id / content_index). The protocol form uses delta:{text|thinking}.
 */
function deltaIsRawAgentCore(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if ('message_id' in p || 'content_index' in p) return false;
  return typeof p['delta'] === 'string';
}
