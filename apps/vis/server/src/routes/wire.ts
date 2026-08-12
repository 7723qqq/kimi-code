import { Hono } from 'hono';
import { join } from 'node:path';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { rehydrateWireEntries } from '../lib/blob-resolver';
import { projectSqliteWire } from '../lib/sqlite-records';
import { readSqliteSessionDetail } from '../lib/sqlite-store';
import { readAgentWire } from '../lib/wire-reader';

export function wireRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/wire', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.query('agent') ?? 'main';
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: 'invalid agent id', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    // SQLite source: the wire view is reconstructed from the engine's
    // `records` table. `main` maps to the session's own records; a subagent
    // id addresses its own (independent) row, which has no records of its
    // own and therefore yields an empty view + warning instead of a 404.
    if (detail.source === 'sqlite') {
      if (agentId !== 'main' && agentId !== id) {
        const sub = readSqliteSessionDetail(undefined, agentId);
        if (sub === null) {
          return c.json({ error: `agent "${agentId}" not found`, code: 'NOT_FOUND' }, 404);
        }
      }
      const recordsSessionId = agentId === 'main' ? id : agentId;
      const result = projectSqliteWire(undefined, recordsSessionId);
      return c.json({
        sessionId: id,
        agentId,
        protocolVersion: result.protocolVersion,
        metadata: result.metadata,
        records: result.records,
        warnings: result.warnings,
      });
    }
    const agent = detail.agents.find((a) => a.agentId === agentId);
    if (!agent) {
      return c.json({ error: `agent "${agentId}" not found`, code: 'NOT_FOUND' }, 404);
    }
    if (!agent.wireExists) {
      return c.json({ error: 'wire missing', code: 'NOT_FOUND' }, 404);
    }
    try {
      const result = await readAgentWire(
        join(detail.sessionDir, 'agents', agentId, 'wire.jsonl'),
      );
      const baseUrl = new URL(c.req.url).origin;
      rehydrateWireEntries(result.records, id, agentId, baseUrl);
      return c.json({
        sessionId: id,
        agentId,
        protocolVersion: result.metadata.protocolVersion,
        metadata: result.metadata,
        records: result.records,
        warnings: result.warnings,
      });
    } catch (error) {
      const msg = (error as Error).message;
      return c.json({ error: msg, code: 'READ_ERROR' }, 500);
    }
  });
  return r;
}
