import { Hono } from 'hono';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { KIMI_CODE_HOME } from '../config';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';
import { isSafeBlobHash } from '../lib/blob-resolver';

/** MIME-type prefixes that are safe to serve as blob content. Anything outside
 *  this set is downgraded to `application/octet-stream` so a hand-edited
 *  blobref URL (e.g. `blobref:text/html;…`) cannot turn the vis server into a
 *  same-origin XSS vector when the blob is opened directly in the browser. */
const SAFE_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'font/'];
const SAFE_MIME_EXACT = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/json',
]);

function sanitizeMime(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (SAFE_MIME_EXACT.has(lower)) return lower;
  if (SAFE_MIME_PREFIXES.some((p) => lower.startsWith(p))) return lower;
  return 'application/octet-stream';
}

export function blobsRoute(home: string = KIMI_CODE_HOME): Hono {
  const r = new Hono();
  r.get('/:id/blobs/:hash', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.query('agent') ?? 'main';
    const hash = c.req.param('hash');
    if (!isSafeAgentId(agentId)) {
      return c.json({ error: 'invalid agent id', code: 'BAD_REQUEST' }, 400);
    }
    if (!isSafeBlobHash(hash)) {
      return c.json({ error: 'invalid blob hash', code: 'BAD_REQUEST' }, 400);
    }
    const detail = await readSessionDetail(home, id);
    if (!detail) {
      return c.json({ error: 'session not found', code: 'NOT_FOUND' }, 404);
    }
    const agent = detail.agents.find((a) => a.agentId === agentId);
    if (!agent) {
      return c.json(
        { error: `agent "${agentId}" not found`, code: 'NOT_FOUND' },
        404,
      );
    }
    const blobPath = join(agent.homedir, 'blobs', hash);
    let content: Buffer;
    try {
      content = await readFile(blobPath);
    } catch {
      return c.json({ error: 'blob not found', code: 'NOT_FOUND' }, 404);
    }
    const rawMime = c.req.query('mime') ?? 'application/octet-stream';
    const mimeType = sanitizeMime(rawMime);
    return new Response(content, {
      headers: {
        'content-type': mimeType,
        // Prevent the browser from sniffing a different content type —
        // without this, IE/Edge legacy may treat octet-stream as HTML.
        'x-content-type-options': 'nosniff',
      },
    });
  });
  return r;
}
