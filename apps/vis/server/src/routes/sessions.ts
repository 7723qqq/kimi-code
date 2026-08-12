import { Hono } from 'hono';
import { rm } from 'node:fs/promises';
import { KIMI_CODE_HOME } from '../config';
import { revealInOs } from '../lib/reveal';
import { isSafeSessionId, listSessions, readSessionDetail } from '../lib/session-store';
import { isSqliteSourceActive } from '../lib/sqlite-store';

export function sessionsRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/', async (c) => {
    const sessions = await listSessions(home);
    return c.json({ sessions });
  });
  r.delete('/:id', async (c) => {
    const id = c.req.param('id');
    // The SQLite source is read-only (a live engine owns the db); deletion
    // is not supported there.
    if (isSqliteSourceActive()) {
      return c.json(
        { error: 'session deletion is not supported for the read-only sqlite source', code: 'BAD_REQUEST' },
        400,
      );
    }
    if (!isSafeSessionId(id)) {
      return c.json({ error: 'invalid session id', code: 'BAD_REQUEST' }, 400);
    }
    const all = await listSessions(home);
    const target = all.find((s) => s.sessionId === id);
    if (!target) return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    await rm(target.sessionDir, { recursive: true, force: true });
    return c.json({ sessionId: id, deleted: true });
  });
  // Open the session directory in the OS file manager. The folder is
  // opened on the SERVER host — only meaningful when vis runs locally.
  r.post('/:id/reveal', async (c) => {
    const id = c.req.param('id');
    // SQLite-sourced sessions have no on-disk session directory to reveal.
    if (isSqliteSourceActive()) {
      return c.json(
        { error: 'reveal is not supported for the sqlite source (no session directory)', code: 'BAD_REQUEST' },
        400,
      );
    }
    if (!isSafeSessionId(id)) {
      return c.json({ error: 'invalid session id', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(home, id);
    if (!detail) return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    try {
      await revealInOs(detail.sessionDir);
      return c.json({ sessionId: id, opened: detail.sessionDir });
    } catch (error) {
      return c.json(
        { error: `failed to open: ${(error as Error).message}`, code: 'READ_ERROR' },
        500,
      );
    }
  });
  return r;
}
