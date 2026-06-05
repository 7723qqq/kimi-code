/**
 * Background Task adapter (Chain 8 / P1.8, W9.2).
 *
 * Translates agent-core's `BackgroundTaskInfo` discriminated union (kind ∈
 * `'process'|'agent'|'question'`, camelCase + ms timestamps, 6-literal status)
 * into SCHEMAS §7 `BackgroundTask` (kind ∈ `'subagent'|'bash'|'tool'`,
 * snake_case + ISO, 4-literal status).
 *
 * Reference table (full rationale lives in `packages/protocol/src/task.ts`
 * header):
 *
 *   kind:    process   → bash
 *            agent     → subagent
 *            question  → tool
 *
 *   status:  running   → running
 *            completed → completed
 *            failed    → failed
 *            timed_out → failed       (lossy — stopReason carries hint)
 *            killed    → cancelled
 *            lost      → failed       (lossy)
 *
 *   timestamps: agent-core has `startedAt: number` + `endedAt: number|null`.
 *               We synthesize `created_at` = `started_at` from `startedAt`;
 *               `completed_at` from `endedAt` when present.
 *
 *   id:         agent-core `taskId` → wire `id` (renamed only).
 *
 *   description: passthrough.
 *
 *   output_preview / output_bytes: NOT surfaced today (agent-core's
 *               `BackgroundTaskInfoBase` has no output fields; output is
 *               fetched separately via `getBackgroundOutput`). Adapter
 *               omits both.
 *
 * Helper exports:
 *   - `isTerminalStatus(status)` — true for `completed|failed|cancelled` (the
 *     three wire-terminal literals). Used by daemon route to choose 40904
 *     envelope vs successful cancel.
 */

import type { BackgroundTaskInfo } from '@moonshot-ai/agent-core';
import type { BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus } from '@moonshot-ai/protocol';

function mapKind(k: BackgroundTaskInfo['kind']): BackgroundTaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
      // SCHEMAS §7 has no 'question' literal; question background tasks are
      // tool-spawned flows (Loop runs them as part of `Question` tool
      // execution), so 'tool' is the closest spec literal.
      return 'tool';
  }
}

function mapStatus(s: BackgroundTaskInfo['status']): BackgroundTaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      // SCHEMAS §7 has no 'timed_out' literal; collapse to 'failed'. The
      // optional `stop_reason`/`last_error` surface would carry the hint
      // once SCHEMAS adds the field (deferred).
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

export function toProtocolTask(sessionId: string, info: BackgroundTaskInfo): BackgroundTask {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: BackgroundTask = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    // Agent-core has no separate creation stamp; we synthesize from
    // startedAt — running tasks usually start immediately after creation.
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    return { ...base, completed_at: new Date(info.endedAt).toISOString() };
  }
  return base;
}
