// Trajectory record model: folds the raw-frame ledger into turn → group →
// record layout, mirroring deepseek-harness ui-trajectory's layout fold
// (MIT). Groups: 'Message' (user/system), 'Step N' (assistant + its tool
// calls), 'Compaction N' / 'Between turns'. Records carry the full detail
// (input/output/thinking/tokens/timing) for the inspector, plus single-line
// summaries for the ledger rows.

import type { LedgerFrame } from './ledger';

export type TrajectoryRecordKind =
  | 'system'
  | 'user'
  | 'compacted'
  | 'assistant'
  | 'tool'
  | 'subtool';

export interface TrajectoryRecord {
  /** Stable identity (kind + source seq / call id). */
  readonly id: string;
  /** 1-based record index shown as #N. */
  readonly index: number;
  readonly kind: TrajectoryRecordKind;
  readonly turn: number | null;
  readonly group: string;
  /** Single-line summary; CSS ellipsis when it overflows. */
  readonly text: string;
  readonly sourceSeq?: number;
  readonly callId?: string;
  readonly toolName?: string;
  readonly opensTurn?: boolean;
  readonly requestOnly?: boolean;
  readonly inputDetail?: string;
  readonly outputDetail?: string;
  readonly thinkingDetail?: string;
  readonly result?: string;
  readonly isError?: boolean;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  readonly think?: number;
  /** Own duration in seconds, or null when unknown. */
  readonly timeSeconds: number | null;
  /** Epoch ms when the operation actually started, when known. */
  readonly startedAt: number | null;
  /** Assistant-only timing facts. */
  readonly ttftMs?: number | null;
  readonly streamMs?: number | null;
  readonly requestBuildMs?: number | null;
  readonly selected?: boolean;
}

export interface TrajectoryGroupModel {
  readonly title: string;
  readonly records: readonly TrajectoryRecord[];
}

export interface TrajectoryTurnModel {
  readonly turn: number | null;
  readonly groups: readonly TrajectoryGroupModel[];
}

const MESSAGE_GROUP = 'Message';

function frameTime(frame: LedgerFrame): number | null {
  const ms = Date.parse(frame.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function durationSeconds(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, (endedAt - startedAt) / 1000);
}

function singleLine(value: string | undefined, max = 240): string {
  if (value === undefined) return '';
  const collapsed = value.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') return b['text'];
      if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') return b['thinking'];
      if (b['type'] === 'tool_use') {
        const toolName = b['tool_name'];
        return `[${typeof toolName === 'string' ? toolName : 'tool'}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function usageFields(usage: unknown): {
  input: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  output: number | undefined;
  think: number | undefined;
} {
  const u =
    usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  const n = (key: string): number | undefined => {
    const v = u[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  return {
    // Total input: non-cached + cache-read + cache-creation (deepseek-harness
    // TrajectoryTable sums the same three into the "input" cell).
    input:
      (n('inputOther') ?? 0) + (n('inputCacheRead') ?? 0) + (n('inputCacheCreation') ?? 0),
    cacheRead: n('inputCacheRead'),
    cacheWrite: n('inputCacheCreation'),
    output: n('output'),
    think: n('reasoningTokens'),
  };
}

interface OpenTool {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: number | null;
  input: string;
  output: string;
  isError: boolean;
  finishedAt: number | null;
}

interface OpenAssistant {
  readonly step: number;
  readonly startedAt: number | null;
  text: string;
  thinking: string;
  interrupted: boolean;
  finishedAt: number | null;
}

interface MutableGroup {
  title: string;
  records: TrajectoryRecord[];
}

interface MutableTurn {
  turn: number | null;
  groups: MutableGroup[];
}

interface Builder {
  turns: MutableTurn[];
  currentTurn: number | null;
  nextTurn: number;
  pendingUser: Omit<TrajectoryRecord, 'index' | 'turn' | 'group'> | null;
  openAssistant: OpenAssistant | null;
  openTools: Map<string, OpenTool>;
  /** Tools whose results arrived but are not settled into a group yet. They
   *  settle AFTER the current step's assistant record so a step's records
   *  keep call order (assistant text first, then its tool calls). */
  pendingTools: OpenTool[];
  index: number;
}

function bucket(b: Builder, turn: number): MutableTurn {
  const existing = b.turns.find((t) => t.turn === turn);
  if (existing !== undefined) return existing;
  const created: MutableTurn = { turn, groups: [] };
  b.turns.push(created);
  return created;
}

function pushRecord(b: Builder, turn: number, group: string, record: Omit<TrajectoryRecord, 'index' | 'turn' | 'group'>): void {
  const t = bucket(b, turn);
  const last = t.groups.at(-1);
  if (last !== undefined && last.title === group) {
    last.records.push({ ...record, index: ++b.index, turn, group });
  } else {
    t.groups.push({ title: group, records: [{ ...record, index: ++b.index, turn, group }] });
  }
}

function settleAssistant(b: Builder, finishedAt: number | null): void {
  const a = b.openAssistant;
  if (a === null) return;
  b.openAssistant = null;
  const turn = b.currentTurn ?? b.nextTurn - 1;
  pushRecord(b, turn, `Step ${a.step}`, {
    id: `assistant\u0000step\u0000${turn}\u0000${a.step}`,
    kind: 'assistant',
    text: singleLine(a.text) || (a.interrupted ? '(interrupted)' : '(empty)'),
    outputDetail: a.text === '' ? undefined : a.text,
    thinkingDetail: a.thinking === '' ? undefined : a.thinking,
    timeSeconds: durationSeconds(a.startedAt, finishedAt ?? a.finishedAt),
    startedAt: a.startedAt,
    ...(a.interrupted ? { isError: true } : {}),
  });
}

/** Settle the open assistant (if any), then any tools whose results arrived
 *  while it was open — in call order. */
function settleStep(b: Builder, finishedAt: number | null): void {
  const step = b.openAssistant?.step ?? 0;
  settleAssistant(b, finishedAt);
  for (const tool of b.pendingTools) {
    settleTool(b, tool.callId, tool, step);
  }
  b.pendingTools = [];
}

function settleTool(b: Builder, callId: string, tool: OpenTool, stepOverride?: number): void {
  const turn = b.currentTurn ?? b.nextTurn - 1;
  const step = stepOverride ?? b.openAssistant?.step ?? 0;
  pushRecord(b, turn, `Step ${step}`, {
    id: `tool\u0000call\u0000${callId}`,
    kind: 'tool',
    callId,
    toolName: tool.toolName,
    text: singleLine(tool.output) || `${tool.toolName} → (no output)`,
    result: singleLine(tool.output) || undefined,
    inputDetail: tool.input === '' ? undefined : tool.input,
    outputDetail: tool.output === '' ? undefined : tool.output,
    isError: tool.isError,
    timeSeconds: durationSeconds(tool.startedAt, tool.finishedAt),
    startedAt: tool.startedAt,
  });
}

/**
 * Fold the ledger into the trajectory layout. Frames outside the ledger's
 * kept set are absent by construction; assistant delta frames merge into
 * their step record, tool results merge into their call record.
 */
export function deriveTrajectoryLayout(frames: readonly LedgerFrame[]): readonly TrajectoryTurnModel[] {
  const b: Builder = {
    turns: [],
    currentTurn: null,
    nextTurn: 1,
    pendingUser: null,
    openAssistant: null,
    openTools: new Map(),
    pendingTools: [],
    index: 0,
  };

  const settlePendingUser = (turn: number): void => {
    const u = b.pendingUser;
    if (u === null) return;
    b.pendingUser = null;
    pushRecord(b, turn, MESSAGE_GROUP, u);
  };

  for (const frame of frames) {
    const p = frame.payload ?? {};
    const time = frameTime(frame);
    switch (frame.type) {
      case 'prompt.submitted': {
        settleStep(b, time);
        const content = textOfContent(p['content'] ?? p['prompt']);
        b.pendingUser = {
          id: `user\u0000seq\u0000${frame.seq}`,
          kind: 'user',
          sourceSeq: frame.seq,
          opensTurn: true,
          text: singleLine(content) || '(empty prompt)',
          inputDetail: content === '' ? undefined : content,
          timeSeconds: 0,
          startedAt: time,
        };
        break;
      }
      case 'turn.started': {
        b.currentTurn = num(p['turnId']) ?? b.nextTurn;
        if (b.currentTurn >= b.nextTurn) b.nextTurn = b.currentTurn + 1;
        settlePendingUser(b.currentTurn);
        break;
      }
      case 'turn.step.started': {
        settleStep(b, time);
        const step = num(p['step']) ?? (b.openAssistant?.step ?? 0) + 1;
        b.openAssistant = { step, startedAt: time, text: '', thinking: '', interrupted: false, finishedAt: null };
        break;
      }
      case 'assistant.delta': {
        if (b.openAssistant !== null) b.openAssistant.text += str(p['text']) ?? '';
        break;
      }
      case 'thinking.delta': {
        if (b.openAssistant !== null) b.openAssistant.thinking += str(p['thinking']) ?? '';
        break;
      }
      case 'tool.use':
      case 'tool.call.started': {
        const callId = str(p['toolCallId']) ?? str(p['tool_call_id']);
        if (callId === undefined || b.openTools.has(callId)) break;
        b.openTools.set(callId, {
          callId,
          toolName: str(p['toolName']) ?? str(p['tool_name']) ?? 'tool',
          startedAt: time,
          input: frame.type === 'tool.use' ? JSON.stringify(p['input'] ?? {}) : '',
          output: '',
          isError: false,
          finishedAt: null,
        });
        break;
      }
      case 'tool.call.delta': {
        break;
      }
      case 'tool.result': {
        const callId = str(p['toolCallId']) ?? str(p['tool_call_id']);
        if (callId === undefined) break;
        const tool = b.openTools.get(callId);
        if (tool === undefined) break;
        tool.finishedAt = time;
        tool.isError = p['isError'] === true;
        const output = p['output'];
        tool.output = typeof output === 'string' ? output : JSON.stringify(output ?? '');
        // Defer settling until the step's assistant record is in place, so a
        // step's records keep call order (assistant text, then tool calls).
        b.pendingTools.push(tool);
        b.openTools.delete(callId);
        break;
      }
      case 'turn.step.completed': {
        const a = b.openAssistant;
        if (a !== null) {
          const usage = usageFields(p['usage']);
          const record: Omit<TrajectoryRecord, 'index' | 'turn' | 'group'> = {
            id: `assistant\u0000step\u0000${b.currentTurn ?? b.nextTurn - 1}\u0000${a.step}`,
            kind: 'assistant',
            text: singleLine(a.text) || '(empty)',
            outputDetail: a.text === '' ? undefined : a.text,
            thinkingDetail: a.thinking === '' ? undefined : a.thinking,
            timeSeconds: durationSeconds(a.startedAt, time),
            startedAt: a.startedAt,
            ttftMs: num(p['llmFirstTokenLatencyMs']) ?? null,
            streamMs: num(p['llmStreamDurationMs']) ?? null,
            requestBuildMs: num(p['llmRequestBuildMs']) ?? null,
            input: usage.input,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            output: usage.output,
            think: usage.think,
          };
          b.openAssistant = null;
          pushRecord(b, b.currentTurn ?? b.nextTurn - 1, `Step ${a.step}`, record);
          // The step's tool calls settle right after their assistant record.
          for (const tool of b.pendingTools) {
            settleTool(b, tool.callId, tool, a.step);
          }
          b.pendingTools = [];
        }
        break;
      }
      case 'turn.step.interrupted': {
        if (b.openAssistant !== null) b.openAssistant.interrupted = true;
        settleStep(b, time);
        break;
      }
      case 'turn.ended': {
        settleStep(b, time);
        for (const [callId, tool] of b.openTools) {
          tool.finishedAt = time;
          settleTool(b, callId, tool);
        }
        b.openTools.clear();
        settlePendingUser(b.currentTurn ?? b.nextTurn);
        b.currentTurn = null;
        break;
      }
      case 'session.history_compacted': {
        settleStep(b, time);
        const reason = str(p['reason']) ?? 'manual_compact';
        const turn = b.currentTurn ?? null;
        const title = `Compaction ${frame.seq}`;
        if (turn === null) {
          const between: MutableTurn = { turn: null, groups: [{ title, records: [{
            id: `compacted\u0000seq\u0000${frame.seq}`,
            index: ++b.index,
            kind: 'compacted',
            turn: null,
            group: title,
            text: `Context compacted (${reason})`,
            sourceSeq: frame.seq,
            timeSeconds: 0,
            startedAt: time,
          }] }] };
          b.turns.push(between);
        } else {
          pushRecord(b, turn, title, {
            id: `compacted\u0000seq\u0000${frame.seq}`,
            kind: 'compacted',
            sourceSeq: frame.seq,
            text: `Context compacted (${reason})`,
            timeSeconds: 0,
            startedAt: time,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // Flush trailing state (session still running).
  settleStep(b, null);
  for (const [callId, tool] of b.openTools) {
    settleTool(b, callId, tool);
  }
  b.openTools.clear();
  settlePendingUser(b.currentTurn ?? b.nextTurn);
  return b.turns.map((t) => ({
    turn: t.turn,
    groups: t.groups.map((g) => ({ title: g.title, records: g.records })),
  }));
}
