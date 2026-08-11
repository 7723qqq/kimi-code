/**
 * Resume replay fold — rebuilds the SDK's `ResumedAgentState.replay` /
 * `toolStore` pair from an agent's `wire.jsonl` over agent-core-v2
 * primitives (the v1 `Agent` restore pipeline is gone with the v1 client).
 *
 * The v2 engine persists each agent's journal at
 * `<sessionDir>/agents/<agentId>/wire.jsonl` using v1's record vocabulary for
 * every replay-relevant op (see `agent-core-v2/src/wire/record.ts` and the op
 * schemas — e.g. `todoOps.ts` states the on-disk vocabulary stays exactly
 * v1's so either engine's reader rebuilds the same state). The fold below is
 * the SDK's own reducer over that journal, mirroring v1's `Agent` restore
 * record-for-record:
 *
 * - message assembly (`context.append_message` / `context.append_loop_event`)
 *   rides the v2 engine's own fold (`foldAppendMessage` / `foldLoopEvent` in
 *   `agent-core-v2/src/agent/contextMemory/loopEventFold.ts`), whose
 *   semantics mirror the v1 fold exactly — assistant messages open at
 *   `step.begin` and mutate in place through `content.part` / `tool.call`,
 *   `tool.result` pushes the tool message, mid-history gaps are closed with
 *   synthesized interrupted results, messages deferred behind an open tool
 *   exchange flush in order, and a vacuous assistant (a retried attempt) is
 *   dropped at `step.end`. Emitted `message` records reference the settled
 *   message objects, matching what v1's restore served.
 * - `full_compaction.begin` → `{type:'compaction', instruction}`;
 *   `context.apply_compaction` patches the last one with `result`;
 *   `full_compaction.cancel` marks it `'cancelled'`
 * - `goal.create` / `goal.update` → `{type:'goal_updated', snapshot, change}`
 *   (`created` / `lifecycle` / `completion`), rebuilt through the same goal
 *   state machine v1's restore ran (budget report math included)
 * - `plan_mode.enter` → `{type:'plan_updated', enabled:true}`;
 *   `plan_mode.cancel` / `plan_mode.exit` → `enabled:false`
 * - `config.update` → `{type:'config_updated', config}` (the raw record
 *   fields, including `type`/`time` — v1's restore quirk, kept)
 * - `permission.set_mode` → `{type:'permission_updated', mode}`
 * - `permission.record_approval_result` → `{type:'approval_result', record}`
 * - `tools.update_store` → no replay record; last-wins into the tool store
 *   returned alongside
 * - `context.clear` / `context.undo` → the cleared/undone messages are
 *   removed from the emitted records (v1's `removeLastMessages`)
 * - `forked` with a live goal → the goal is cleared and the fork reminder is
 *   appended as a user message, mirroring v1's `restoreForked`
 * - everything else (metadata, turn.*, usage.record, profile.bind,
 *   tools.set_active_tools, task.*, skill.activate, interaction.*,
 *   token_counting.*, llm.*, ...) rebuilds state only and produces no replay
 *   record (v2-only ops fall through the switch untouched, exactly as they
 *   fell through v1's restore)
 *
 * The fold is pure and never mutates the journal. Any failure — missing or
 * corrupt file, newer protocol, unexpected record — degrades to an empty
 * result instead of failing the session resume.
 *
 * The record vocabulary is typed loosely here on purpose: the SDK must keep
 * folding journals from both engines, and neither package exports a public
 * per-record type for every op the journal can carry.
 */

import { readFile } from 'node:fs/promises';

import type { ContextMessage } from '@moonshot-ai/agent-core-v2';
import type { AgentReplayRecord } from '@moonshot-ai/agent-core-v2';
import {
  foldAppendMessage,
  foldLoopEvent,
  resetFold,
  type LoopRecordedEvent,
} from '@moonshot-ai/agent-core-v2';
import type { CompactionResult } from '@moonshot-ai/agent-core-v2';
import type {
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalSnapshot,
  GoalStatus,
} from '@moonshot-ai/agent-core-v2';

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

/** Any wire record the fold can encounter (see the module header). */
interface WireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

const FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
];

interface GoalFoldState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
  blockedStreak?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Fold one agent's `wire.jsonl` into the SDK replay records and tool-store
 * snapshot. Best-effort: unreadable or malformed journals yield an empty
 * fold, never a rejected resume.
 */
export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  try {
    const records = parseWireRecords(await readFile(wirePath, 'utf-8'));
    if (records.length === 0) return EMPTY_FOLD;
    return foldWireRecords(records);
  } catch {
    return EMPTY_FOLD;
  }
}

/**
 * The v1 line reader's rules: blank lines skipped, a truncated TAIL line
 * tolerated (the last write may have crashed mid-flush), corruption anywhere
 * else is an error.
 */
function parseWireRecords(content: string): WireRecord[] {
  const lines = content.split('\n');
  const records: WireRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return records;
}

function foldWireRecords(records: readonly WireRecord[]): FoldedAgentReplay {
  const replay: AgentReplayRecord[] = [];
  const toolStore: Record<string, unknown> = {};
  let context: readonly ContextMessage[] = [];
  // The open assistant step (see the module header): its replay record index
  // and the live message object, refreshed as the fold mutates it.
  let openAssistantRecord: number | undefined;
  let openAssistantMessage: ContextMessage | undefined;
  let goal: GoalFoldState | undefined;

  const emitMessageRecord = (message: ContextMessage, time: number): void => {
    replay.push({ type: 'message', message, time });
  };

  /**
   * Align the emitted message records with a freshly folded context array:
   * the open assistant's object identity changes on every mutation (the v2
   * fold is immutable), so its record is re-pointed at the current object;
   * a vacuous assistant dropped at `step.end` removes its record; appended
   * messages (tool results, flushed deferred messages) emit in order.
   */
  const syncContext = (
    prev: readonly ContextMessage[],
    next: readonly ContextMessage[],
    time: number,
  ): void => {
    if (openAssistantRecord !== undefined && openAssistantMessage !== undefined) {
      const record = replay[openAssistantRecord];
      if (record !== undefined && record.type === 'message') {
        const prevIndex = prev.indexOf(openAssistantMessage);
        if (prevIndex !== -1) {
          const current = next[prevIndex];
          if (current === openAssistantMessage) {
            // Unchanged by this fold step.
          } else if (current !== undefined && current.role === 'assistant') {
            // Immutable replacement by the fold (content.part / tool.call /
            // step.end settle) — re-point the record at the new object.
            openAssistantMessage = current;
            record.message = current;
          } else {
            // Vacuous assistant dropped at step.end — remove its record.
            replay.splice(openAssistantRecord, 1);
            openAssistantRecord = undefined;
            openAssistantMessage = undefined;
          }
        }
      }
    }
    for (let i = prev.length; i < next.length; i++) {
      const message = next[i];
      if (message !== undefined) emitMessageRecord(message, time);
    }
  };

  const removeRecordsForMessages = (removed: ReadonlySet<ContextMessage>): void => {
    for (let i = replay.length - 1; i >= 0; i--) {
      const record = replay[i];
      if (record !== undefined && record.type === 'message' && removed.has(record.message)) {
        replay.splice(i, 1);
      }
    }
    if (openAssistantRecord !== undefined && replay[openAssistantRecord] === undefined) {
      openAssistantRecord = undefined;
      openAssistantMessage = undefined;
    }
  };

  const foldMessage = (message: ContextMessage, time: number): void => {
    const prev = context;
    context = foldAppendMessage(prev, message);
    syncContext(prev, context, time);
  };

  const foldEvent = (event: LoopRecordedEvent, time: number): void => {
    const prev = context;
    context = foldLoopEvent(prev, event);
    syncContext(prev, context, time);
    if (event.type === 'step.begin') {
      // The fold appended the open assistant; its record is the last emitted
      // one (v1 emitted at step.begin too). Track it for in-place updates.
      const assistant = context[context.length - 1];
      if (assistant !== undefined && assistant.role === 'assistant') {
        openAssistantRecord = replay.length - 1;
        openAssistantMessage = assistant;
      }
    } else if (event.type === 'step.end') {
      openAssistantRecord = undefined;
      openAssistantMessage = undefined;
    }
  };

  for (const record of records) {
    const time = record.time ?? Date.now();
    switch (record.type) {
      case 'context.append_message': {
        const message = record['message'] as ContextMessage;
        if (message !== undefined) foldMessage(message, time);
        break;
      }
      case 'context.append_loop_event': {
        const event = record['event'] as LoopRecordedEvent;
        if (event !== undefined) foldEvent(event, time);
        break;
      }
      case 'context.clear': {
        const removed = new Set(context);
        resetFold(context);
        context = [];
          openAssistantRecord = undefined;
        openAssistantMessage = undefined;
        removeRecordsForMessages(removed);
        break;
      }
      case 'context.undo': {
        const count = typeof record['count'] === 'number' ? record['count'] : 0;
        const removed = undoMessages(context, count);
        if (removed.size > 0) {
          context = context.filter((message) => !removed.has(message));
          resetFold(context);
              openAssistantRecord = undefined;
          openAssistantMessage = undefined;
          removeRecordsForMessages(removed);
        }
        break;
      }
      case 'context.apply_compaction': {
        patchLastCompaction(replay, { result: compactionResultFromRecord(record) });
        break;
      }
      case 'full_compaction.begin': {
        const instruction =
          typeof record['instruction'] === 'string' ? record['instruction'] : undefined;
        replay.push({ type: 'compaction', instruction, time });
        break;
      }
      case 'full_compaction.cancel': {
        patchLastCompaction(replay, { result: 'cancelled' });
        break;
      }
      case 'goal.create': {
        goal = {
          goalId: String(record['goalId']),
          objective: String(record['objective']),
          completionCriterion:
            typeof record['completionCriterion'] === 'string'
              ? record['completionCriterion']
              : undefined,
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          wallClockMs: 0,
          budgetLimits: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        replay.push({
          type: 'goal_updated',
          snapshot: goalSnapshotFromState(goal),
          change: { kind: 'created' },
          time,
        });
        break;
      }
      case 'goal.update': {
        if (goal === undefined) break;
        const status = record['status'] as GoalStatus | undefined;
        if (status !== undefined) {
          goal.status = status;
          // v1's restore: a re-activated goal clears the terminal reason; any
          // other status adopts the record's reason (undefined when absent).
          goal.terminalReason =
            status === 'active' ? undefined : typeof record['reason'] === 'string' ? record['reason'] : undefined;
        }
        if (typeof record['turnsUsed'] === 'number') goal.turnsUsed = record['turnsUsed'];
        if (typeof record['tokensUsed'] === 'number') goal.tokensUsed = record['tokensUsed'];
        if (typeof record['wallClockMs'] === 'number') goal.wallClockMs = record['wallClockMs'];
        if (record['budgetLimits'] !== undefined) {
          goal.budgetLimits = record['budgetLimits'] as GoalBudgetLimits;
        }
        if (typeof record['blockedStreak'] === 'number') {
          goal.blockedStreak = record['blockedStreak'];
        }
        if (status === undefined) break;
        const actor = record['actor'] as GoalActor | undefined;
        replay.push({
          type: 'goal_updated',
          snapshot: goalSnapshotFromState(goal),
          change:
            status === 'complete'
              ? {
                  kind: 'completion',
                  status,
                  reason: typeof record['reason'] === 'string' ? record['reason'] : undefined,
                  stats: {
                    turnsUsed: goal.turnsUsed,
                    tokensUsed: goal.tokensUsed,
                    wallClockMs: goal.wallClockMs,
                  },
                  actor,
                }
              : {
                  kind: 'lifecycle',
                  status,
                  reason: typeof record['reason'] === 'string' ? record['reason'] : undefined,
                  actor,
                },
          time,
        });
        break;
      }
      case 'goal.clear': {
        goal = undefined;
        break;
      }
      case 'forked': {
        const hadGoal = goal !== undefined;
        goal = undefined;
        if (!hadGoal) break;
        foldMessage(
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<system-reminder>\n${FORK_CLEARED_REMINDER.join(' ').trim()}\n</system-reminder>`,
              },
            ],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'goal_fork_cleared' },
          },
          time,
        );
        break;
      }
      case 'plan_mode.enter': {
        replay.push({ type: 'plan_updated', enabled: true, time });
        break;
      }
      case 'plan_mode.cancel':
      case 'plan_mode.exit': {
        replay.push({ type: 'plan_updated', enabled: false, time });
        break;
      }
      case 'config.update': {
        const { type: _type, time: _time, ...changed } = record;
        if (Object.keys(changed).length === 0) break;
        replay.push({
          type: 'config_updated',
          // v1's restore quirk: the record fields (including `type`/`time`)
          // ride along in the replay `config`.
          config: record as unknown as Extract<AgentReplayRecord, { type: 'config_updated' }>['config'],
          time,
        });
        break;
      }
      case 'permission.set_mode': {
        const mode = record['mode'];
        if (mode === 'yolo' || mode === 'manual' || mode === 'auto') {
          replay.push({ type: 'permission_updated', mode, time });
        }
        break;
      }
      case 'permission.record_approval_result': {
        const { type: _type, time: _time, ...approval } = record;
        replay.push({
          type: 'approval_result',
          record: approval as unknown as Extract<
            AgentReplayRecord,
            { type: 'approval_result' }
          >['record'],
          time,
        });
        break;
      }
      case 'tools.update_store': {
        const key = record['key'];
        if (typeof key === 'string') {
          toolStore[key] = record['value'];
        }
        break;
      }
      default:
        break;
    }
  }

  return { replay, toolStore };
}

/**
 * v1's `context.undo`: remove trailing messages from history (skipping
 * injection-origin messages, stopping at a compaction-summary boundary) until
 * `count` real user inputs were removed. Returns the removed message set.
 */
function undoMessages(
  history: readonly ContextMessage[],
  count: number,
): Set<ContextMessage> {
  const removed = new Set<ContextMessage>();
  if (count <= 0) return removed;
  let removedUserCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') break;
    removed.add(message);
    if (isRealUserInput(message)) {
      removedUserCount++;
      if (removedUserCount >= count) break;
    }
  }
  return removed;
}

function isRealUserInput(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
      return message.origin.trigger === 'user-slash';
    case 'plugin_command':
      return message.origin.trigger === 'user-slash';
    case 'shell_command':
      return message.origin.phase === 'input';
    default:
      return false;
  }
}

function patchLastCompaction(
  replay: AgentReplayRecord[],
  patch: Partial<Extract<AgentReplayRecord, { type: 'compaction' }>>,
): void {
  for (let i = replay.length - 1; i >= 0; i--) {
    const record = replay[i];
    if (record !== undefined && record.type === 'compaction') {
      Object.assign(record, patch);
      return;
    }
  }
}

function compactionResultFromRecord(record: WireRecord): CompactionResult {
  return {
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    ...(typeof record['contextSummary'] === 'string'
      ? { contextSummary: record['contextSummary'] }
      : {}),
    compactedCount: Number(record['compactedCount'] ?? 0),
    tokensBefore: Number(record['tokensBefore'] ?? 0),
    tokensAfter: Number(record['tokensAfter'] ?? 0),
    ...(typeof record['keptUserMessageCount'] === 'number'
      ? { keptUserMessageCount: record['keptUserMessageCount'] }
      : {}),
    ...(typeof record['keptHeadUserMessageCount'] === 'number'
      ? { keptHeadUserMessageCount: record['keptHeadUserMessageCount'] }
      : {}),
    ...(typeof record['droppedCount'] === 'number' ? { droppedCount: record['droppedCount'] } : {}),
  };
}

/** v1's goal `toSnapshot` + `computeBudgetReport` fallback (no native engine). */
function goalSnapshotFromState(state: GoalFoldState): GoalSnapshot {
  const budget = computeBudgetReport(state);
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    inputTokensUsed: 0,
    outputTokensUsed: 0,
    wallClockMs: state.wallClockMs,
    budget,
    terminalReason: state.terminalReason,
    blockedStreak: state.blockedStreak,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function computeBudgetReport(state: GoalFoldState): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && state.wallClockMs >= wallClockBudgetMs;
  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - state.wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
    inputTokensUsed: 0,
    outputTokensUsed: 0,
  };
}
