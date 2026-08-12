// apps/vis/server/src/lib/sqlite-records.ts
//
// Records → wire view projection + context timeline rebuild (vis 断代适配
// 阶段 2). The Rust engine persists a per-session append-only event log in
// the `records` table of `sessions.db` (see
// `packages/kimi-agent/src/persistence/record_store.rs` for the
// `RECORD_TYPE_*` dictionary and the data_json shapes). This module turns
// those rows into the vis `WireEntry` stream so the wire tab renders engine
// sessions, and rebuilds the conversation timeline for `?history=full`.
//
// Projection design (stage-2 contract, consumed by apps/vis/web wire UI):
//
// - `lineNo` = the record's `id` (stable, ascending; the UI uses it as the
//   React key, for jump-to-line and for tool.call ↔ tool.result pairing).
// - `data` is mapped onto the closest legacy wire shape so the existing
//   renderers light up instead of falling back to the generic JSON dump:
//   - `message.append`        → `context.append_message` (snake_case
//     ContextMessage normalized to the vis camelCase `ContextMessage`);
//   - `tool.call` / `tool.result` → `context.append_loop_event` with a
//     `tool.call` / `tool.result` event, so the pair indicator, hover
//     highlight and duration (WireTab computePairMap) work unchanged;
//   - `usage.updated`         → `usage.record`;
//   - `goal.updated`          → `goal.update` (the engine serializes
//     `GoalSnapshot` with `rename_all = "camelCase"`, so the payload
//     passes through verbatim);
//   - everything else (`turn.started`, `turn.ended`,
//     `compaction.started`, `compaction.completed`, future types) → a
//     generic shape `{ type: <record_type>, time, ...data_json }`; the UI
//     falls back to its neutral unknown-type renderer (TypeBadge shows the
//     raw type string, headline "unknown record type", detail JSON dump).
// - `raw` is the engine-shaped record as persisted (`type` + snake_case
//   `data_json` fields) — "as written" for the detail panel's raw view.
// - Every projected entry carries `time` = epoch ms parsed from the
//   record's ISO `created_at`, so the row's wall-clock column works.
// - `metadata` reports `protocolVersion: 'records'`, `source: 'sqlite'`
//   and the distinct `recordTypes` seen for the session; `warnings`
//   notes the records start position so the UI can surface the caveat.

import type { AgentRecord, WireEntry, WireMetadata } from './agent-record-types';
import type { ProjectedMessage } from './context-projector';
import { normalizeContextMessage, sessionsDbPath, tryOpenDb } from './sqlite-store';

/** `protocolVersion` reported for the records-based wire view. */
export const RECORDS_PROTOCOL_VERSION = 'records';

/** One `records` row, decoded. */
export interface SqliteWireRecord {
  /** Row id — becomes the `WireEntry.lineNo`. */
  id: number;
  turnId: string;
  recordType: string;
  /** Parsed `data_json`. */
  data: unknown;
  /** Epoch ms parsed from `created_at`; 0 when unparseable. */
  createdAtMs: number;
}

export interface SqliteWireResult {
  protocolVersion: string;
  metadata: WireMetadata;
  records: WireEntry[];
  warnings: string[];
}

// ── records reading ─────────────────────────────────────────────────────────

/** All records for one session, oldest first (`ORDER BY id`). Rows whose
 *  `data_json` is not valid JSON are skipped with their count collected in
 *  `invalidCount` so the caller can warn. */
export function readSqliteRecords(
  homeDir: string | undefined,
  sessionId: string,
): { records: SqliteWireRecord[]; invalidCount: number } {
  const db = tryOpenDb(sessionsDbPath(homeDir));
  if (db === null) return { records: [], invalidCount: 0 };
  try {
    const rows = db
      .prepare(
        'SELECT id, turn_id, record_type, data_json, created_at FROM records WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    const records: SqliteWireRecord[] = [];
    let invalidCount = 0;
    for (const row of rows) {
      const id = row['id'];
      const recordType = row['record_type'];
      if (typeof id !== 'number' || typeof recordType !== 'string') continue;
      const data = parseDataJson(row['data_json']);
      if (data === undefined) {
        invalidCount += 1;
        continue;
      }
      records.push({
        id,
        turnId: typeof row['turn_id'] === 'string' ? row['turn_id'] : '',
        recordType,
        data,
        createdAtMs: parseIsoMs(row['created_at']),
      });
    }
    return { records, invalidCount };
  } finally {
    db.close();
  }
}

// ── wire projection ─────────────────────────────────────────────────────────

/** Project a session's `records` into the vis wire view. Never throws for
 *  missing data: a session without records yields an empty record list plus
 *  a warning (the wire route serves that instead of 404 so the UI can show
 *  "该会话无 wire 记录"). */
export function projectSqliteWire(
  homeDir: string | undefined,
  sessionId: string,
): SqliteWireResult {
  const { records, invalidCount } = readSqliteRecords(homeDir, sessionId);
  const warnings: string[] = [];
  if (invalidCount > 0) {
    warnings.push(`${invalidCount} record(s) had unparseable data_json and were skipped`);
  }
  if (records.length === 0) {
    return {
      protocolVersion: RECORDS_PROTOCOL_VERSION,
      metadata: {
        protocolVersion: RECORDS_PROTOCOL_VERSION,
        createdAt: 0,
        source: 'sqlite',
        recordTypes: [],
      },
      records: [],
      warnings: [
        ...warnings,
        'no wire records for this session — the engine records table has no rows for it (sessions created before records recording, or subagent rows, have no wire view)',
      ],
    };
  }
  const recordTypes: string[] = [];
  const seen = new Set<string>();
  const entries: WireEntry[] = [];
  for (const row of records) {
    entries.push(projectRecord(row));
    if (!seen.has(row.recordType)) {
      seen.add(row.recordType);
      recordTypes.push(row.recordType);
    }
  }
  warnings.push(
    `records-based wire view (first record #${records[0]!.id}, ${records.length} total)`,
  );
  return {
    protocolVersion: RECORDS_PROTOCOL_VERSION,
    metadata: {
      protocolVersion: RECORDS_PROTOCOL_VERSION,
      createdAt: records[0]!.createdAtMs,
      source: 'sqlite',
      recordTypes,
    },
    records: entries,
    warnings,
  };
}

function projectRecord(row: SqliteWireRecord): WireEntry {
  const time = row.createdAtMs > 0 ? row.createdAtMs : undefined;
  return {
    lineNo: row.id,
    data: mapRecord(row, time),
    raw: rawOf(row),
  };
}

/** The engine-persisted shape: `type` (the record_type) plus the snake_case
 *  `data_json` payload — "as written", mirroring the legacy reader's raw
 *  line. */
function rawOf(row: SqliteWireRecord): unknown {
  const data = isRecord(row.data) ? row.data : {};
  return { type: row.recordType, ...data };
}

/** Map one engine record onto the closest legacy wire shape (see module
 *  doc). Unknown record types pass through as a generic shape; the UI's
 *  unknown-type fallback renders them. */
function mapRecord(row: SqliteWireRecord, time: number | undefined): AgentRecord {
  const data = isRecord(row.data) ? row.data : {};
  switch (row.recordType) {
    case 'message.append': {
      const message = normalizeContextMessage(data);
      if (message !== null) {
        return { type: 'context.append_message', time, message };
      }
      break;
    }
    case 'tool.call': {
      const toolCallId = typeof data['tool_call_id'] === 'string' ? data['tool_call_id'] : '';
      const name = typeof data['name'] === 'string' ? data['name'] : '';
      // The engine record has no step/uuid granularity (the loop-event
      // fields are absent by definition), so the event carries only what
      // the wire UI consumes: toolCallId/name/args (+turnId for context).
      return {
        type: 'context.append_loop_event',
        time,
        event: {
          type: 'tool.call',
          toolCallId,
          name,
          args: data['input'],
          ...(row.turnId.length > 0 ? { turnId: row.turnId } : {}),
        },
      } as unknown as AgentRecord;
    }
    case 'tool.result': {
      const toolCallId = typeof data['tool_call_id'] === 'string' ? data['tool_call_id'] : '';
      const output = typeof data['output'] === 'string' ? data['output'] : '';
      const isError = data['is_error'] === true;
      return {
        type: 'context.append_loop_event',
        time,
        event: {
          type: 'tool.result',
          toolCallId,
          result: { output, ...(isError ? { isError: true } : {}) },
        },
      } as unknown as AgentRecord;
    }
    case 'usage.updated':
      return {
        type: 'usage.record',
        time,
        model: typeof data['model'] === 'string' ? data['model'] : 'unknown',
        usage: {
          inputOther: toFiniteNumber(data['input_tokens'], 0),
          output: toFiniteNumber(data['output_tokens'], 0),
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        usageScope: 'session',
      };
    case 'goal.updated':
      // Engine GoalSnapshot is serialized camelCase, which is exactly the
      // vis `goal.update` shape — pass the payload through verbatim.
      return { type: 'goal.update', time, ...data } as unknown as AgentRecord;
  }
  // turn.started / turn.ended / compaction.started / compaction.completed,
  // unparseable message.append payloads, and any future record types:
  // generic shape, UI fallback renderer.
  return { type: row.recordType, time, ...data } as unknown as AgentRecord;
}

// ── context timeline rebuild ────────────────────────────────────────────────

/**
 * Rebuild the conversation timeline from the session's `records`
 * `message.append` sequence. Returns `null` when the session has no records
 * (the caller keeps the state_json snapshot projection). Each message maps
 * to a `ProjectedMessage` with `lineNo` = record id and `time` = record
 * timestamp, so the reconstructed list shows the FULL append history —
 * including messages dropped from the live snapshot by compaction — which is
 * the `?history=full` semantics for the SQLite source.
 */
export function rebuildTimelineFromRecords(
  homeDir: string | undefined,
  sessionId: string,
): ProjectedMessage[] | null {
  const { records } = readSqliteRecords(homeDir, sessionId);
  if (records.length === 0) return null;
  const messages: ProjectedMessage[] = [];
  for (const row of records) {
    if (row.recordType !== 'message.append') continue;
    const message = normalizeContextMessage(row.data);
    if (message === null) continue;
    messages.push({
      lineNo: row.id,
      time: row.createdAtMs > 0 ? row.createdAtMs : undefined,
      source: 'append_message',
      message,
      toolStepUuids: [],
    });
  }
  return messages;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseDataJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseIsoMs(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : 0;
}

function toFiniteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
