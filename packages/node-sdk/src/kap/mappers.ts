import type { SessionSummary } from '@moonshot-ai/agent-core';
import type { Session as ProtocolSession } from '@moonshot-ai/protocol';

import type { JsonObject } from '../types';

/**
 * Map a KAP protocol `session` to the SDK `SessionSummary` shape the TUI expects.
 *
 * Known localization gap: KAP `session` has no `sessionDir`; only `metadata.cwd`.
 * We fall back to `cwd` for `sessionDir` so the field is populated. The
 * `goal-queue-store` write to `<sessionDir>/upcoming-goals.json` is resolved in
 * Phase 9 (localization).
 */
export function toSessionSummary(session: ProtocolSession): SessionSummary {
  const cwd = typeof session.metadata?.cwd === 'string' ? session.metadata.cwd : '';
  return {
    id: session.id,
    title: session.title,
    lastPrompt: session.last_prompt,
    workDir: cwd,
    sessionDir: cwd, // localization gap — see Phase 9
    createdAt: Date.parse(session.created_at),
    updatedAt: Date.parse(session.updated_at),
    archived: session.archived,
    metadata: session.metadata as JsonObject | undefined,
  };
}

export interface CreateSessionPayloadLike {
  readonly id?: string;
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: 'yolo' | 'manual' | 'auto';
  readonly metadata?: Record<string, unknown>;
}

/** Build `POST /sessions` body (`sessionCreateSchema`) from a CoreAPI create payload. */
export function toCreateSessionBody(payload: CreateSessionPayloadLike): Record<string, unknown> {
  const agentConfig: Record<string, unknown> = {};
  if (payload.model !== undefined) agentConfig['model'] = payload.model;
  if (payload.thinking !== undefined) agentConfig['thinking'] = payload.thinking;
  if (payload.permission !== undefined) agentConfig['permission_mode'] = payload.permission;
  return {
    metadata: { ...(payload.metadata ?? {}), cwd: payload.workDir },
    ...(Object.keys(agentConfig).length > 0 ? { agent_config: agentConfig } : {}),
  };
}
