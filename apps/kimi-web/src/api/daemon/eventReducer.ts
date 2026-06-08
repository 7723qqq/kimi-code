// apps/kimi-web/src/api/daemon/eventReducer.ts
// Pure TypeScript state reducer for KimiClient.
// Operates on plain TS state — no Vue reactivity here.
// The reducer consumes AppEvent (camelCase), produced by toAppEvent() in mappers.ts.
//
// No-op-but-known events (tool.*, assistant streaming, assistant.completed)
// are mapped to { type: 'unknown', raw: { _noop: true, ... } } by mappers.ts.
// The reducer detects `_noop: true` and silently advances lastSeqBySession
// without pushing a warning.

import type {
  AppApprovalRequest,
  AppEvent,
  AppMessage,
  AppMessageContent,
  AppQuestionRequest,
  AppSession,
  AppTask,
} from '../types';
import { i18n } from '../../i18n';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface KimiClientState {
  sessions: AppSession[];
  activeSessionId?: string;
  messagesBySession: Record<string, AppMessage[]>;
  approvalsBySession: Record<string, AppApprovalRequest[]>;
  questionsBySession: Record<string, AppQuestionRequest[]>;
  tasksBySession: Record<string, AppTask[]>;
  lastSeqBySession: Record<string, number>;
  warnings: string[];
}

export function createInitialState(): KimiClientState {
  return {
    sessions: [],
    activeSessionId: undefined,
    messagesBySession: {},
    approvalsBySession: {},
    questionsBySession: {},
    tasksBySession: {},
    lastSeqBySession: {},
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneState(s: KimiClientState): KimiClientState {
  return {
    ...s,
    sessions: [...s.sessions],
    messagesBySession: { ...s.messagesBySession },
    approvalsBySession: { ...s.approvalsBySession },
    questionsBySession: { ...s.questionsBySession },
    tasksBySession: { ...s.tasksBySession },
    lastSeqBySession: { ...s.lastSeqBySession },
    warnings: [...s.warnings],
  };
}

function advanceSeq(state: KimiClientState, sessionId: string | undefined, seq: number | undefined): void {
  if (sessionId !== undefined && seq !== undefined && seq > 0) {
    const prev = state.lastSeqBySession[sessionId] ?? 0;
    if (seq > prev) {
      state.lastSeqBySession[sessionId] = seq;
    }
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply a single AppEvent to the state, returning a new state object.
 * The event carries `_wireSeq` and `_wireSessionId` as hidden extras when
 * produced by the client wrapper, but the reducer only depends on the
 * AppEvent.type discriminant.
 *
 * Extra metadata attached by the caller:
 *   meta.sessionId — wire session_id for lastSeqBySession update
 *   meta.seq       — wire seq for lastSeqBySession update
 */
export interface EventMeta {
  sessionId: string;
  seq: number;
}

export function reduceAppEvent(
  state: KimiClientState,
  event: AppEvent,
  meta: EventMeta,
): KimiClientState {
  const next = cloneState(state);

  // Always advance lastSeqBySession for every event that carries seq info.
  advanceSeq(next, meta.sessionId, meta.seq);

  switch (event.type) {
    // -------------------------------------------------------------------------
    case 'sessionCreated': {
      const exists = next.sessions.some((s) => s.id === event.session.id);
      if (!exists) {
        next.sessions = [event.session, ...next.sessions];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionUpdated': {
      next.sessions = next.sessions.map((s) =>
        s.id === event.session.id ? event.session : s,
      );
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionDeleted': {
      const id = event.sessionId;
      next.sessions = next.sessions.filter((s) => s.id !== id);
      delete next.messagesBySession[id];
      delete next.tasksBySession[id];
      delete next.approvalsBySession[id];
      delete next.questionsBySession[id];
      delete next.lastSeqBySession[id];
      if (next.activeSessionId === id) {
        next.activeSessionId = undefined;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionStatusChanged': {
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        return {
          ...s,
          status: event.status,
          currentPromptId: event.currentPromptId,
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionMetaUpdated': {
      // Lightweight title patch — the daemon's auto-generated title (or a title
      // changed by another client) arrives via session.meta.updated. We patch
      // only the title field; the full session object stays as-is.
      next.sessions = next.sessions.map((s) =>
        s.id === event.sessionId ? { ...s, title: event.title } : s,
      );
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionUsageUpdated': {
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        // The live model name (from agent.status.updated) rides along with usage.
        // Only overwrite model when a non-empty one is supplied.
        const model = event.model && event.model.length > 0 ? event.model : s.model;
        return { ...s, usage: event.usage, model };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'historyCompacted': {
      // Only advance lastSeqBySession; actual reload is triggered by client wrapper
      // when it sees this event type (before_seq is in event.beforeSeq).
      // The advanceSeq at top already handled seq update.
      break;
    }

    // -------------------------------------------------------------------------
    case 'messageCreated': {
      const sid = event.message.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      const exists = msgs.some((m) => m.id === event.message.id);
      if (!exists) {
        next.messagesBySession[sid] = [...msgs, event.message];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'messageUpdated': {
      const sid = event.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      next.messagesBySession[sid] = msgs.map((m) => {
        if (m.id !== event.messageId) return m;
        return { ...m, content: event.content };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'assistantDelta': {
      const sid = event.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      next.messagesBySession[sid] = msgs.map((m) => {
        if (m.id !== event.messageId) return m;
        const content = [...m.content];
        const idx = event.contentIndex;
        // Ensure the slot exists
        while (content.length <= idx) {
          content.push({ type: 'text', text: '' });
        }
        const existing = content[idx]!;
        let patched: AppMessageContent;
        if (event.delta.text !== undefined) {
          if (existing.type === 'text') {
            patched = { type: 'text', text: existing.text + event.delta.text };
          } else {
            patched = { type: 'text', text: event.delta.text };
          }
        } else if (event.delta.thinking !== undefined) {
          if (existing.type === 'thinking') {
            patched = {
              type: 'thinking',
              thinking: existing.thinking + event.delta.thinking,
              signature: existing.signature,
            };
          } else {
            patched = { type: 'thinking', thinking: event.delta.thinking };
          }
        } else {
          patched = existing;
        }
        content[idx] = patched;
        return { ...m, content };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'approvalRequested': {
      const sid = event.sessionId;
      const list = next.approvalsBySession[sid] ?? [];
      const exists = list.some((a) => a.approvalId === event.approval.approvalId);
      if (!exists) {
        next.approvalsBySession[sid] = [...list, event.approval];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'approvalResolved':
    case 'approvalExpired': {
      const sid = event.sessionId;
      const aid = event.approvalId;
      const list = next.approvalsBySession[sid] ?? [];
      next.approvalsBySession[sid] = list.filter((a) => a.approvalId !== aid);
      break;
    }

    // -------------------------------------------------------------------------
    case 'questionRequested': {
      const sid = event.sessionId;
      const list = next.questionsBySession[sid] ?? [];
      const exists = list.some((q) => q.questionId === event.question.questionId);
      if (!exists) {
        next.questionsBySession[sid] = [...list, event.question];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'questionAnswered':
    case 'questionDismissed':
    case 'questionExpired': {
      const sid = event.sessionId;
      const qid = event.questionId;
      const list = next.questionsBySession[sid] ?? [];
      next.questionsBySession[sid] = list.filter((q) => q.questionId !== qid);
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskCreated': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      const idx = list.findIndex((t) => t.id === event.task.id);
      if (idx === -1) {
        next.tasksBySession[sid] = [...list, event.task];
      } else {
        const patched = [...list];
        patched[idx] = event.task;
        next.tasksBySession[sid] = patched;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskProgress': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      next.tasksBySession[sid] = list.map((t) => {
        if (t.id !== event.taskId) return t;
        return {
          ...t,
          outputLines: [...(t.outputLines ?? []), event.outputChunk],
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskCompleted': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      next.tasksBySession[sid] = list.map((t) => {
        if (t.id !== event.taskId) return t;
        return {
          ...t,
          status: event.status,
          outputPreview: event.outputPreview,
          outputBytes: event.outputBytes,
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'unknown': {
      // Distinguish no-op known events (sentinel _noop) from agent errors/warnings
      // and truly unknown events.
      const raw = event.raw as {
        _noop?: boolean;
        _agentError?: boolean;
        _agentWarning?: boolean;
        code?: string;
        message?: string;
        type?: string;
      } | null;
      if (raw && raw._noop === true) {
        // No-op streaming/tool event — seq already advanced, nothing else to do
      } else if (raw && (raw._agentError || raw._agentWarning)) {
        // Surface the agent's real error/warning message (e.g. a 403 from the
        // model provider) instead of a useless "Unhandled event".
        const label = raw._agentError
          ? i18n.global.t('warnings.errorLabel')
          : i18n.global.t('warnings.noteLabel');
        const msg = raw.message ?? raw.code ?? 'agent error';
        next.warnings = [...next.warnings, `${label}: ${msg}`];
      } else {
        // Truly unknown — push a warning
        const wireType = raw?.type ?? '(unknown)';
        next.warnings = [...next.warnings, `Unhandled event: ${wireType}`];
      }
      break;
    }

    default: {
      // TypeScript exhaustiveness guard — should not reach here
      const _exhaustive: never = event;
      void _exhaustive;
      break;
    }
  }

  return next;
}
