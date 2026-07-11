import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { Hono } from 'hono';

import { KIMI_CODE_HOME } from './config';
import { serveWebAsset, type WebAsset } from './lib/web-asset';
import { blobsRoute } from './routes/blobs';
import { contextRoute } from './routes/context';
import { cronRoute } from './routes/cron';
import { importsRoute } from './routes/imports';
import { logsRoute } from './routes/logs';
import { sessionDetailRoute } from './routes/session-detail';
import { sessionsRoute } from './routes/sessions';
import { subagentsRoute } from './routes/subagents';
import { tasksRoute } from './routes/tasks';
import { wireRoute } from './routes/wire';

/** Resolve the SPA bundle directory next to the compiled server.mjs, if it
 * exists. Returns `null` in dev mode where the web bundle lives elsewhere. */
async function resolvePublicDir(): Promise<string | null> {
  try {
    const here = import.meta.dirname;
    const candidate = resolve(here, 'public');
    const s = await stat(candidate);
    if (s.isDirectory()) return candidate;
  } catch {
    // not present
  }
  return null;
}

const STATIC_EXT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(path: string): string {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = path.slice(i).toLowerCase();
  return STATIC_EXT_MIME[ext] ?? 'application/octet-stream';
}

export interface CreateAppOptions {
  readonly authToken?: string;
  readonly homeDir?: string;
  /** When provided, serve this single-file SPA from memory and skip the
   *  filesystem `public/` lookup. */
  readonly webAsset?: WebAsset;
}

function bearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? null;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Build a Hono app mounting /api/* routes, plus SPA static fallback. */
export async function createApp(options: CreateAppOptions = {}): Promise<Hono> {
  const app = new Hono();

  // /api/* handlers.
  const api = new Hono();
  const authToken = options.authToken;
  const home = options.homeDir ?? KIMI_CODE_HOME;
  if (authToken !== undefined && authToken.length > 0) {
    api.use('*', async (c, next) => {
      const token = bearerToken(c.req.header('authorization'));
      if (token !== null && tokenMatches(token, authToken)) {
        await next();
        return;
      }
      c.header('www-authenticate', 'Bearer realm="kimi-vis"');
      return c.json({ error: 'unauthorized', code: 'UNAUTHORIZED' }, 401);
    });
  } else {
    // CSRF defence for the loopback-no-auth mode: a malicious website on a
    // different origin can send simple cross-origin POSTs (and some DELETEs
    // via preflight) to `http://127.0.0.1:<port>/api/…` without the user's
    // consent. Reject state-changing methods (POST / PUT / PATCH / DELETE)
    // whose Origin or Referer header does not match the server's own host.
    // Browser clients always send one of these headers on such requests;
    // curl / scripts send neither, so they are unaffected.
    const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    api.use('*', async (c, next) => {
      if (!unsafeMethods.has(c.req.method)) {
        await next();
        return;
      }
      const origin = c.req.header('origin');
      const referer = c.req.header('referer');
      if (origin === undefined && referer === undefined) {
        // Non-browser client — allow.
        await next();
        return;
      }
      const expectedHost = new URL(`http://${c.req.header('host') ?? 'localhost'}`).host;
      let allowed = false;
      if (origin !== undefined) {
        try {
          allowed = new URL(origin).host === expectedHost;
        } catch {
          allowed = false;
        }
      }
      if (!allowed && referer !== undefined) {
        try {
          allowed = new URL(referer).host === expectedHost;
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        return c.json({ error: 'cross-origin request blocked', code: 'FORBIDDEN' }, 403);
      }
      await next();
    });
  }
  api.route('/sessions', sessionsRoute(home));
  api.route('/sessions', sessionDetailRoute(home));
  api.route('/sessions', wireRoute(home));
  api.route('/sessions', subagentsRoute(home));
  api.route('/sessions', blobsRoute(home));
  api.route('/sessions', tasksRoute(home));
  api.route('/sessions', cronRoute(home));
  api.route('/sessions', logsRoute(home));
  api.route('/imports', importsRoute(home));
  // Mount contextRoute last because it currently uses a catch-all stub
  // (Phase C scope) that would otherwise shadow more specific routes
  // registered below it.
  api.route('/sessions', contextRoute(home));

  app.route('/api', api);

  // Static + SPA fallback.
  if (options.webAsset !== undefined) {
    // Serve the embedded single-file SPA from memory for any non-/api GET.
    const asset = options.webAsset;
    app.get('*', (c) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.startsWith('/api')) {
        // Should have been routed above; 404 here.
        return c.json({ error: `api route not found: ${pathname}`, code: 'NOT_FOUND' }, 404);
      }
      return serveWebAsset(asset);
    });
  } else {
    // Filesystem static serving (production standalone only).
    const publicDir = await resolvePublicDir();
    if (publicDir !== null) {
      app.get('*', async (c) => {
        const url = new URL(c.req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.startsWith('/api')) {
          // Should have been routed above; 404 here.
          return c.json({ error: `api route not found: ${pathname}`, code: 'NOT_FOUND' }, 404);
        }
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        const resolved = resolve(publicDir, `.${pathname}`);
        // Use `publicDir + sep` (not bare `publicDir`) so a sibling directory
        // whose name is a string-prefix of publicDir (e.g. `/app/publicx`
        // when publicDir is `/app/public`) does not bypass the containment
        // check — `startsWith('/app/public')` would match `/app/publicx/…`.
        if (resolved !== publicDir && !resolved.startsWith(publicDir + sep)) {
          return c.text('forbidden', 403);
        }
        try {
          const s = await stat(resolved);
          if (s.isFile()) {
            const buf = await readFile(resolved);
            const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            return new Response(body, {
              headers: {
                'content-type': mimeFor(resolved),
                'x-content-type-options': 'nosniff',
              },
            });
          }
        } catch {
          // fall through to SPA fallback
        }
        // SPA fallback — index.html for any unknown GET so client-side
        // React Router can resolve the route.
        try {
          const indexHtml = await readFile(join(publicDir, 'index.html'));
          const body = new Uint8Array(indexHtml.buffer, indexHtml.byteOffset, indexHtml.byteLength);
          return new Response(body, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        } catch {
          return c.text('not found', 404);
        }
      });
    }
  }

  return app;
}
