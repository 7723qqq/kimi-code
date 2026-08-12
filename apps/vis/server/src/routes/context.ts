import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { rehydrateWireEntries } from '../lib/blob-resolver';
import { rebuildTimelineFromRecords } from '../lib/sqlite-records';
import { projectSqliteContext, readSqliteSessionDetail } from '../lib/sqlite-store';
import { readAgentWire } from '../lib/wire-reader';
import { projectContext } from '../lib/context-projector';

export function contextRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/context', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.query('agent') ?? 'main';
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: 'invalid agent id', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    // SQLite source: the persisted context is projected directly from
    // state_json (snake_case → vis camelCase). When the session has engine
    // `records`, the timeline is rebuilt from the `message.append` sequence
    // instead — the records are append-only, so `?history=full` (and the
    // default view) shows the FULL history including messages dropped from
    // the live snapshot by compaction, which the state_json snapshot cannot.
    // A non-`main` agent id addresses a subagent row in the sessions table
    // (subagents never write records, so their projection stays snapshot).
    if (detail.source === 'sqlite') {
      let state = detail.state;
      let recordsSessionId = id;
      if (agentId !== 'main' && agentId !== id) {
        const sub = readSqliteSessionDetail(undefined, agentId);
        if (sub === null) {
          return c.json({ error: `agent "${agentId}" not found`, code: 'NOT_FOUND' }, 404);
        }
        state = sub.state;
        recordsSessionId = agentId;
      }
      const proj = projectSqliteContext(state);
      const fromRecords = rebuildTimelineFromRecords(undefined, recordsSessionId);
      if (fromRecords !== null) {
        proj.messages = fromRecords;
      }
      return c.json({ sessionId: id, agentId, ...proj });
    }
    const agent = detail.agents.find((a) => a.agentId === agentId);
    if (!agent || !agent.wireExists) {
      return c.json({ error: 'agent wire not found', code: 'NOT_FOUND' }, 404);
    }
    try {
      const wire = await readAgentWire(
        join(detail.sessionDir, 'agents', agentId, 'wire.jsonl'),
      );
      const baseUrl = new URL(c.req.url).origin;
      rehydrateWireEntries(wire.records, id, agentId, baseUrl);
      // `?history=full` reconstructs the FULL pre-compaction/undo/clear history
      // for debugging; the default mirrors the model's-eye post-compaction view.
      const mode = c.req.query('history') === 'full' ? 'full' : 'model';
      const proj = projectContext(wire.records, mode);
      return c.json({
        sessionId: id,
        agentId,
        messages: proj.messages,
        usage: proj.usage,
        contextTokens: proj.contextTokens,
        config: proj.config,
        permission: proj.permission,
        planMode: proj.planMode,
        goal: proj.goal,
        swarm: proj.swarm,
      });
    } catch (error) {
      const msg = (error as Error).message;
      return c.json({ error: msg, code: 'READ_ERROR' }, 500);
    }
  });
  return r;
}
