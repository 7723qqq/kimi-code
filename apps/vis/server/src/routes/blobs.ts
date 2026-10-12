import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

import { KIMI_CODE_HOME } from '../config';
import { isSafeBlobHash } from '../lib/blob-resolver';
import { isSafeAgentId, readSessionDetail } from '../lib/session-store';

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

/** Types that are DOCUMENTS the browser executes on this origin, whatever their
 *  family. `image/svg+xml` is the one that hides inside `image/`: an SVG can
 *  carry script, and it is served from the vis loopback origin that the API
 *  trusts, so opening one is same-origin code execution. `+xml` covers the
 *  other XML-derived document types; the PDF and JSON entries above are
 *  deliberately not XML. */
const UNSAFE_DOCUMENT_MIMES = new Set([
  'image/svg+xml',
  'image/svg',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

function isUnsafeDocumentMime(lower: string): boolean {
  return UNSAFE_DOCUMENT_MIMES.has(lower) || lower.endsWith('+xml');
}

function sanitizeMime(raw: string): { mimeType: string; attachment: boolean } {
  const lower = raw.toLowerCase().trim();
  if (isUnsafeDocumentMime(lower)) return { mimeType: 'application/octet-stream', attachment: true };
  if (SAFE_MIME_EXACT.has(lower)) return { mimeType: lower, attachment: false };
  if (SAFE_MIME_PREFIXES.some((p) => lower.startsWith(p))) return { mimeType: lower, attachment: false };
  return { mimeType: 'application/octet-stream', attachment: false };
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
      return c.json({ error: `agent "${agentId}" not found`, code: 'NOT_FOUND' }, 404);
    }
    const blobPath = join(agent.homedir, 'blobs', hash);
    let content: Buffer;
    try {
      content = await readFile(blobPath);
    } catch {
      return c.json({ error: 'blob not found', code: 'NOT_FOUND' }, 404);
    }
    const rawMime = c.req.query('mime') ?? 'application/octet-stream';
    const { mimeType, attachment } = sanitizeMime(rawMime);
    return new Response(content, {
      headers: {
        'content-type': mimeType,
        // Prevent the browser from sniffing a different content type —
        // without this, IE/Edge legacy may treat octet-stream as HTML.
        'x-content-type-options': 'nosniff',
        // Defense in depth for anything that still renders as a document:
        // `sandbox` drops the origin, so even a slipped-through document type
        // cannot call the same-origin API. Inline images are unaffected.
        'content-security-policy': 'sandbox',
        ...(attachment
          ? { 'content-disposition': `attachment; filename="${hash}"` }
          : {}),
      },
    });
  });
  return r;
}
