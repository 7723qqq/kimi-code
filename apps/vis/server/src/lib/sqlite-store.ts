// apps/vis/server/src/lib/sqlite-store.ts
//
// Read-only reader for the Rust engine's SQLite persistence (阶段 1B, vis 断代
// 适配基础层). The engine stores sessions in `$KIMI_AGENT_HOME/sessions.db`
// (sessions / records / cron_tasks / bg_tasks / blob_store) and tasks in
// `$KIMI_AGENT_HOME/agent_tasks.db` (task_records / task_output /
// bg_task_records / bg_task_output).
//
// Design notes:
// - Every access opens a dedicated read-only connection (`DatabaseSync(path,
//   { readOnly: true })`) and closes it afterwards. The engine holds a normal
//   read-write connection; a read-only connection never blocks it and never
//   risks SQLITE_BUSY on its behalf, and per-call open/close keeps tests
//   (which pin `KIMI_AGENT_HOME` to a temp dir per file) free of stale
//   connection state. A missing / unreadable db file simply yields "no data".
// - Rows are queried by id as bound parameters (never string-interpolated),
//   so arbitrary engine session ids are safe to serve.
// - Wire shapes are the Rust serde forms (snake_case, e.g. `tool_calls`,
//   `tool_call_id`, `is_error`); the vis DTOs are the retired agent-core
//   camelCase forms. `normalizeContextMessage` / task normalization map one
//   to the other, mirroring what the wire-reader migration chain used to do
//   for the legacy directory layout.
// - The `sessions` table holds BOTH main-session records (state_json is a
//   serialized `SessionRecord` with id/created_at/updated_at/title/work_dir)
//   and subagent durable-state rows (state_json is `Agent::durable_state()`
//   — context/goal/metadata/… without those keys). `isMainSessionState`
//   mirrors the engine's `SessionRecord::is_subagent` + `is_valid_shape`
//   classification (a non-empty-string id/created_at/updated_at triple).

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { KIMI_CODE_HOME, resolveVisSource } from '../config';
import type {
  AgentInfo,
  BackgroundTaskStatus,
  ContextMessage,
  CronTask,
  PromptOrigin,
  SessionDetail,
  SessionSummary,
  TokenUsage,
} from './agent-record-types';
import type {
  ContextProjection,
  GoalSnapshot,
  ProjectedMessage,
  UsageTotals,
} from './context-projector';
import type { TaskOutputWindow } from './task-store';

const ZERO: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

// ── home resolution ─────────────────────────────────────────────────────────

/**
 * The Rust engine's persistence home: `$KIMI_AGENT_HOME` when set, else
 * `<kimi-code home>/agent` (the layout the retired rust-loop bridge seeded).
 * `homeDir` overrides both for callers that pin the location explicitly
 * (tests).
 */
export function resolveAgentHome(homeDir?: string): string {
  if (homeDir !== undefined && homeDir.length > 0) return homeDir;
  const envHome = process.env['KIMI_AGENT_HOME'];
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim();
  return join(KIMI_CODE_HOME, 'agent');
}

/** True when the session-data source is SQLite — `KIMI_VIS_SOURCE=sqlite`,
 *  or `auto` with a readable engine `sessions.db`. */
export function isSqliteSourceActive(): boolean {
  const source = resolveVisSource();
  return source === 'sqlite' || (source === 'auto' && hasSqliteData());
}

// ── connection helpers ──────────────────────────────────────────────────────

export function sessionsDbPath(homeDir?: string): string {
  return join(resolveAgentHome(homeDir), 'sessions.db');
}

function tasksDbPath(homeDir?: string): string {
  return join(resolveAgentHome(homeDir), 'agent_tasks.db');
}

/** Open a read-only connection, or `null` when the file is missing or
 *  unreadable (e.g. still being initialized by the engine). */
export function tryOpenDb(path: string): DatabaseSync | null {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

/** Whether the engine home holds a readable `sessions.db` — the `auto`
 *  source-switch predicate. */
export function hasSqliteData(homeDir?: string): boolean {
  const db = tryOpenDb(sessionsDbPath(homeDir));
  if (db === null) return false;
  db.close();
  return true;
}

// ── session listing / detail ────────────────────────────────────────────────

/**
 * List main sessions from the engine's `sessions.db`, newest first. Subagent
 * rows (state_json in `Agent::durable_state()` shape) are filtered out;
 * unreadable state_json rows are treated as subagent (not trustworthy main
 * sessions), mirroring the engine's `is_subagent()`.
 *
 * Fields the legacy layout used to provide but SQLite does not carry
 * (`lastPrompt`, `isCustomTitle`, agent wire stats) degrade to conservative
 * defaults; `sessionDir` is empty because there is no on-disk session
 * directory.
 */
export function listSqliteSessions(homeDir?: string): SessionSummary[] {
  const db = tryOpenDb(sessionsDbPath(homeDir));
  if (db === null) return [];
  try {
    const rows = db
      .prepare('SELECT id, created_at, updated_at, state_json FROM sessions')
      .all() as Array<Record<string, unknown>>;
    const out: SessionSummary[] = [];
    for (const row of rows) {
      const id = row['id'];
      if (typeof id !== 'string') continue;
      const state = parseJsonObject(row['state_json']);
      if (state === null || !isMainSessionState(state)) continue;
      const title = state['title'];
      out.push({
        sessionId: id,
        sessionDir: '',
        workDir: typeof state['work_dir'] === 'string' ? state['work_dir'] : '',
        title: typeof title === 'string' && title.length > 0 ? title : null,
        lastPrompt: null,
        isCustomTitle: false,
        createdAt: parseTsString(row['created_at']),
        updatedAt: parseTsString(row['updated_at']),
        agentCount: 0,
        mainAgentExists: false,
        mainWireRecordCount: 0,
        wireProtocolVersion: null,
        health: 'ok',
        imported: false,
        importMeta: null,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } finally {
    db.close();
  }
}

/** Read one session's detail from `sessions.db`. The `agents` inventory is
 *  synthesized: a main session exposes `main` plus one flat entry per
 *  subagent row in the table (parent links are not persisted, so every
 *  subagent is `independent` with a null parent); a subagent row exposes
 *  only itself. */
export function readSqliteSessionDetail(
  homeDir: string | undefined,
  sessionId: string,
): SessionDetail | null {
  const db = tryOpenDb(sessionsDbPath(homeDir));
  if (db === null) return null;
  try {
    const row = db
      .prepare('SELECT id, created_at, updated_at, state_json FROM sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    // Unreadable state_json is tolerated: mirroring the engine's
    // `is_subagent()` (unreadable records classify as subagent), such a row
    // still resolves as its own session with `state: null`.
    const state = parseJsonObject(row['state_json']);
    const isMain = state !== null && isMainSessionState(state);
    const workDir =
      isMain && state !== null && typeof state['work_dir'] === 'string'
        ? state['work_dir']
        : '';
    return {
      sessionId,
      sessionDir: '',
      workDir,
      state,
      agents: isMain ? mainSessionAgents(db) : [subagentAgentInfo(sessionId)],
      imported: false,
      importMeta: null,
      source: 'sqlite',
    };
  } finally {
    db.close();
  }
}

function mainSessionAgents(db: DatabaseSync): AgentInfo[] {
  const agents: AgentInfo[] = [mainAgentInfo()];
  const rows = db.prepare('SELECT id, state_json FROM sessions').all() as Array<
    Record<string, unknown>
  >;
  for (const row of rows) {
    const id = row['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    // Everything that is not a valid main-session state classifies as a
    // subagent row (mirroring the engine's `is_subagent()` tolerance of
    // unreadable records).
    const state = parseJsonObject(row['state_json']);
    if (state !== null && isMainSessionState(state)) continue;
    agents.push(subagentAgentInfo(id));
  }
  return agents;
}

function mainAgentInfo(): AgentInfo {
  return {
    agentId: 'main',
    type: 'main',
    parentAgentId: null,
    homedir: '',
    wireExists: false,
    wireRecordCount: 0,
    wireProtocolVersion: null,
    swarmItem: null,
  };
}

function subagentAgentInfo(id: string): AgentInfo {
  return {
    agentId: id,
    type: 'independent',
    parentAgentId: null,
    homedir: '',
    wireExists: false,
    wireRecordCount: 0,
    wireProtocolVersion: null,
    swarmItem: null,
  };
}

/** Main-session shape check, mirroring the engine's `is_subagent()` +
 *  `is_valid_shape()`: a SessionRecord serializes id/created_at/updated_at as
 *  non-empty strings; `Agent::durable_state()` has none of those keys. */
function isMainSessionState(state: Record<string, unknown>): boolean {
  return (
    typeof state['id'] === 'string' &&
    state['id'] !== '' &&
    typeof state['created_at'] === 'string' &&
    state['created_at'] !== '' &&
    typeof state['updated_at'] === 'string' &&
    state['updated_at'] !== ''
  );
}

// ── context projection ──────────────────────────────────────────────────────

/**
 * Project a persisted session's context into the vis `ContextProjection`
 * shape. `state` is either a SessionRecord (main session — context lives at
 * `agent_state.context`) or `Agent::durable_state()` (subagent row — context
 * at the top level). Degradations vs the wire-reconstructed projection:
 *
 * - `messages` is the persisted final history verbatim (`source:
 *   'append_message'`, sequential line numbers); `?history=full` yields the
 *   same list — the pre-compaction/undo history is not persisted.
 * - `usage` totals are unavailable and return zeroes; `permission.mode` is
 *   `null` and `swarm` inactive (not persisted).
 * - `contextTokens` / `planMode` / `goal` come from the durable state
 *   (`token_count` / `plan_active` / `plan_id` / `goal`).
 */
export function projectSqliteContext(state: unknown): ContextProjection {
  const s = isRecord(state) ? state : {};
  const isMain = isMainSessionState(s);
  const agentState = isMain ? (isRecord(s['agent_state']) ? s['agent_state'] : {}) : s;

  const messages: ProjectedMessage[] = [];
  const contextRaw = agentState['context'];
  if (Array.isArray(contextRaw)) {
    for (let i = 0; i < contextRaw.length; i++) {
      const message = normalizeContextMessage(contextRaw[i]);
      if (message === null) continue;
      messages.push({ lineNo: i + 1, source: 'append_message', message, toolStepUuids: [] });
    }
  }

  const usage: UsageTotals = {
    byScope: { session: { ...ZERO }, turn: { ...ZERO } },
    byModel: {},
  };

  const tokenCount = agentState['token_count'];
  const planActive = agentState['plan_active'] === true;
  const planId = typeof agentState['plan_id'] === 'string' ? agentState['plan_id'] : undefined;

  return {
    messages,
    usage,
    contextTokens: typeof tokenCount === 'number' ? tokenCount : 0,
    config: { cwd: typeof s['work_dir'] === 'string' ? s['work_dir'] : undefined },
    permission: { mode: null },
    planMode: { active: planActive, id: planId },
    goal: normalizeGoal(agentState['goal']),
    swarm: { active: false },
  };
}

/** Map one Rust `ContextMessage` (snake_case) to the vis camelCase shape.
 *  Unknown content-part types (tool_use / tool_result — not in the legacy
 *  wire ContentPart union) are passed through verbatim; the UI's part
 *  renderer falls back to its generic JSON branch for them. */
export function normalizeContextMessage(raw: unknown): ContextMessage | null {
  if (!isRecord(raw) || typeof raw['role'] !== 'string') return null;
  const message: ContextMessage = {
    role: raw['role'] as ContextMessage['role'],
    content: [],
    toolCalls: [],
    ...(typeof raw['tool_call_id'] === 'string' ? { toolCallId: raw['tool_call_id'] } : {}),
    ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['partial'] === 'boolean' ? { partial: raw['partial'] } : {}),
    ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
    ...(raw['is_error'] === true ? { isError: true } : {}),
    ...(isRecord(raw['origin']) ? { origin: raw['origin'] as unknown as PromptOrigin } : {}),
  };
  const content = raw['content'];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part) || typeof part['type'] !== 'string') continue;
      switch (part['type']) {
        case 'text':
          if (typeof part['text'] === 'string') {
            message.content.push({ type: 'text', text: part['text'] });
          }
          break;
        case 'think': {
          const think = typeof part['think'] === 'string' ? part['think'] : '';
          const encrypted = typeof part['encrypted'] === 'string' ? part['encrypted'] : undefined;
          message.content.push(encrypted === undefined ? { type: 'think', think } : { type: 'think', think, encrypted });
          break;
        }
        case 'image_url':
          pushMediaPart(message, part, 'image_url');
          break;
        case 'audio_url':
          pushMediaPart(message, part, 'audio_url');
          break;
        case 'video_url':
          pushMediaPart(message, part, 'video_url');
          break;
        default:
          // tool_use / tool_result / future part kinds: pass through verbatim.
          message.content.push(part as unknown as ContextMessage['content'][number]);
          break;
      }
    }
  }
  const toolCalls = raw['tool_calls'];
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const normalized = normalizeToolCall(call);
      if (normalized !== null) message.toolCalls.push(normalized);
    }
  }
  return message;
}

function mediaFieldOf(type: 'image_url' | 'audio_url' | 'video_url'): 'imageUrl' | 'audioUrl' | 'videoUrl' {
  switch (type) {
    case 'image_url':
      return 'imageUrl';
    case 'audio_url':
      return 'audioUrl';
    case 'video_url':
      return 'videoUrl';
  }
}

function pushMediaPart(
  message: { content: ContextMessage['content'] },
  part: Record<string, unknown>,
  type: 'image_url' | 'audio_url' | 'video_url',
): void {
  const field = mediaFieldOf(type);
  const container = isRecord(part[type]) ? part[type] : null;
  const url = container !== null && typeof container['url'] === 'string' ? container['url'] : '';
  const id = container !== null && typeof container['id'] === 'string' ? container['id'] : undefined;
  const normalized: Record<string, unknown> = {
    type,
    [field]: id === undefined ? { url } : { url, id },
  };
  message.content.push(normalized as unknown as ContextMessage['content'][number]);
}

/** Rust `ToolCall` ({type, id, name, arguments: Value}) → vis `ToolCall`
 *  (arguments stringified, matching how tool calls travel on the wire). */
function normalizeToolCall(raw: unknown): ContextMessage['toolCalls'][number] | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') {
    return null;
  }
  const args = raw['arguments'];
  return {
    type: 'function',
    id: raw['id'],
    name: raw['name'],
    arguments:
      args === undefined || args === null ? null : typeof args === 'string' ? args : JSON.stringify(args),
  };
}

/** Rust `GoalState` (snake_case) → vis `GoalSnapshot` (camelCase). */
function normalizeGoal(raw: unknown): GoalSnapshot | null {
  if (!isRecord(raw)) return null;
  const goalId = raw['goal_id'];
  const objective = raw['objective'];
  if (typeof goalId !== 'string' || typeof objective !== 'string') return null;
  const out: GoalSnapshot = { goalId, objective };
  if (typeof raw['completion_criterion'] === 'string') out.completionCriterion = raw['completion_criterion'];
  if (typeof raw['status'] === 'string') out.status = raw['status'];
  if (typeof raw['tokens_used'] === 'number') out.tokensUsed = raw['tokens_used'];
  if (typeof raw['turns_used'] === 'number') out.turnsUsed = raw['turns_used'];
  if (typeof raw['wall_clock_ms'] === 'number') out.wallClockMs = raw['wall_clock_ms'];
  if (typeof raw['terminal_reason'] === 'string') out.reason = raw['terminal_reason'];
  return out;
}

// ── background tasks ────────────────────────────────────────────────────────

/**
 * A background task as persisted by the engine, normalized to the vis
 * camelCase `BackgroundTaskInfo` shape. `task_records` stores only the flat
 * `TaskInfoBase` (no command/pid — the engine's TaskPersistence interface
 * never sees them), while `bg_task_records` stores the full info with a
 * nested `base`; the optional process/agent fields are absent when the
 * engine did not persist them. Distinct from the legacy
 * `BackgroundTaskEntry.task` union only in that those fields are optional.
 */
export interface SqliteTaskInfo {
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  kind: 'process' | 'agent' | 'question';
  startedAt: number;
  endedAt: number | null;
  detached: boolean;
  stopReason?: string;
  timeoutMs?: number;
  /** Process tasks (bg_task_records only). */
  command?: string;
  pid?: number;
  exitCode?: number;
  /** Agent tasks: the resumable subagent id. */
  agentId?: string;
  subagentType?: string;
}

export interface SqliteBackgroundTaskEntry {
  task: SqliteTaskInfo;
  /** Which agent the UI attributes the task to — `info_json.agent_id` for
   *  agent-kind tasks, else `main`. */
  agentId: string;
  outputSizeBytes: number;
  outputExists: boolean;
}

/** All persisted background tasks from `agent_tasks.db` (task_records +
 *  bg_task_records), newest first, with output sizes. */
export function listSqliteTasks(homeDir?: string): SqliteBackgroundTaskEntry[] {
  const db = tryOpenDb(tasksDbPath(homeDir));
  if (db === null) return [];
  try {
    const out: SqliteBackgroundTaskEntry[] = [];
    const flatRows = db.prepare('SELECT info_json FROM task_records').all() as Array<
      Record<string, unknown>
    >;
    for (const row of flatRows) {
      const raw = parseJsonObject(row['info_json']);
      const task = normalizeFlatTaskInfo(raw);
      if (task === null) continue;
      const agentId = task.agentId !== undefined && task.agentId.length > 0 ? task.agentId : 'main';
      const outputSizeBytes = outputSizeBytesOf(db, 'task_output', task.taskId);
      out.push({ task, agentId, outputSizeBytes, outputExists: outputSizeBytes > 0 });
    }
    const bgRows = db.prepare('SELECT info_json FROM bg_task_records').all() as Array<
      Record<string, unknown>
    >;
    for (const row of bgRows) {
      const raw = parseJsonObject(row['info_json']);
      const task = normalizeBgTaskInfo(raw);
      if (task === null) continue;
      const agentId = task.agentId !== undefined && task.agentId.length > 0 ? task.agentId : 'main';
      const outputSizeBytes = outputSizeBytesOf(db, 'bg_task_output', task.taskId);
      out.push({ task, agentId, outputSizeBytes, outputExists: outputSizeBytes > 0 });
    }
    out.sort((a, b) => (b.task.startedAt ?? 0) - (a.task.startedAt ?? 0));
    return out;
  } finally {
    db.close();
  }
}

/** Byte-window of a task's persisted output. The task may live in either
 *  output table (task_records tasks → task_output, bg → bg_task_output); the
 *  table with any content wins. Mirrors `readTaskOutput`'s byte-offset
 *  paging semantics (offsets are byte offsets into the UTF-8 text, matching
 *  the legacy output.log reader). */
export function readSqliteTaskOutput(
  homeDir: string | undefined,
  taskId: string,
  offset: number,
  maxBytes: number,
): TaskOutputWindow {
  const start = Math.max(0, Math.trunc(offset));
  const limit = Math.max(0, Math.trunc(maxBytes));
  const db = tryOpenDb(tasksDbPath(homeDir));
  if (db === null) return { offset: start, nextOffset: start, size: 0, content: '', eof: true };
  try {
    let full = readOutputOf(db, 'task_output', taskId);
    if (full.length === 0) full = readOutputOf(db, 'bg_task_output', taskId);
    const bytes = Buffer.from(full, 'utf8');
    const size = bytes.length;
    if (limit === 0 || start >= size) {
      return { offset: start, nextOffset: start, size, content: '', eof: start >= size };
    }
    const length = Math.min(limit, size - start);
    const content = bytes.subarray(start, start + length).toString('utf8');
    const nextOffset = start + length;
    return { offset: start, nextOffset, size, content, eof: nextOffset >= size };
  } finally {
    db.close();
  }
}

/** All persisted cron jobs from `agent_tasks.db` (the engine's shared task
 *  database — cron_tasks is created there alongside bg/task tables),
 *  oldest first. */
export function listSqliteCron(homeDir?: string): CronTask[] {
  const db = tryOpenDb(tasksDbPath(homeDir));
  if (db === null) return [];
  try {
    const rows = db
      .prepare('SELECT id, cron_expr, prompt, recurring, created_at, last_fired FROM cron_tasks')
      .all() as Array<Record<string, unknown>>;
    const out: CronTask[] = [];
    for (const row of rows) {
      const id = row['id'];
      const cron = row['cron_expr'];
      const prompt = row['prompt'];
      if (typeof id !== 'string' || typeof cron !== 'string' || typeof prompt !== 'string') {
        continue;
      }
      const createdMs = parseMsString(row['created_at']);
      const lastFiredMs = parseMsStringOrUndefined(row['last_fired']);
      out.push({
        id,
        cron,
        prompt,
        createdAt: createdMs,
        recurring: row['recurring'] !== 0,
        ...(lastFiredMs === undefined ? {} : { lastFiredAt: lastFiredMs }),
      });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  } finally {
    db.close();
  }
}

// ── normalization internals ─────────────────────────────────────────────────

/** Flat `TaskInfoBase` JSON → SqliteTaskInfo. */
function normalizeFlatTaskInfo(raw: Record<string, unknown> | null): SqliteTaskInfo | null {
  if (raw === null) return null;
  const taskId = raw['task_id'];
  const description = raw['description'];
  if (typeof taskId !== 'string' || typeof description !== 'string') return null;
  const kind = raw['kind'];
  const out: SqliteTaskInfo = {
    taskId,
    description,
    status: normalizeTaskStatus(raw['status']),
    kind: kind === 'agent' ? 'agent' : kind === 'question' ? 'question' : 'process',
    startedAt: toFiniteNumber(raw['started_at'], 0),
    endedAt: toFiniteNumberOrNull(raw['ended_at']),
    detached: raw['detached'] === true,
  };
  if (typeof raw['stop_reason'] === 'string') out.stopReason = raw['stop_reason'];
  if (typeof raw['timeout_ms'] === 'number' && Number.isFinite(raw['timeout_ms'])) {
    out.timeoutMs = raw['timeout_ms'];
  }
  if (typeof raw['agent_id'] === 'string') out.agentId = raw['agent_id'];
  return out;
}

/** Full `BackgroundTaskInfo` JSON (bg_task_records): untagged enum variant
 *  with a nested `base` plus variant fields. */
function normalizeBgTaskInfo(raw: Record<string, unknown> | null): SqliteTaskInfo | null {
  if (raw === null) return null;
  const base = isRecord(raw['base']) ? raw['base'] : raw;
  const task = normalizeFlatTaskInfo(base);
  if (task === null) return null;
  const kind = raw['kind'];
  if (kind === 'agent') {
    task.kind = 'agent';
    if (typeof raw['agent_id'] === 'string') task.agentId = raw['agent_id'];
    if (typeof raw['subagent_type'] === 'string') task.subagentType = raw['subagent_type'];
  } else if (kind === 'question') {
    task.kind = 'question';
  } else {
    task.kind = 'process';
    if (typeof raw['command'] === 'string') task.command = raw['command'];
    if (typeof raw['pid'] === 'number' && Number.isFinite(raw['pid'])) task.pid = raw['pid'];
    if (typeof raw['exit_code'] === 'number' && Number.isFinite(raw['exit_code'])) {
      task.exitCode = raw['exit_code'];
    }
  }
  return task;
}

function normalizeTaskStatus(raw: unknown): BackgroundTaskStatus {
  if (
    raw === 'running' ||
    raw === 'completed' ||
    raw === 'failed' ||
    raw === 'timed_out' ||
    raw === 'killed' ||
    raw === 'lost'
  ) {
    return raw;
  }
  return 'running';
}

function outputSizeBytesOf(db: DatabaseSync, table: 'task_output' | 'bg_task_output', taskId: string): number {
  // LENGTH() on TEXT counts UTF-8 characters, not bytes; casting to BLOB
  // recovers the byte length (the engine appends UTF-8 chunks).
  const row = db
    .prepare(`SELECT COALESCE(SUM(LENGTH(CAST(chunk AS BLOB))), 0) AS s FROM ${table} WHERE task_id = ?`)
    .get(taskId) as Record<string, unknown> | undefined;
  return typeof row?.['s'] === 'number' ? row['s'] : 0;
}

function readOutputOf(db: DatabaseSync, table: 'task_output' | 'bg_task_output', taskId: string): string {
  const rows = db
    .prepare(`SELECT chunk FROM ${table} WHERE task_id = ? ORDER BY id`)
    .all(taskId) as Array<Record<string, unknown>>;
  let out = '';
  for (const row of rows) {
    if (typeof row['chunk'] === 'string') out += row['chunk'];
  }
  return out;
}

// ── JSON / scalar helpers ───────────────────────────────────────────────────

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Engine timestamps are ISO-8601 strings (sessions) or decimal ms strings
 *  (cron). Returns epoch ms; 0 when unparseable. */
function parseTsString(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseMsString(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseMsStringOrUndefined(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function toFiniteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function toFiniteNumberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
