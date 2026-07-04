#!/usr/bin/env node
// apps/kimi-web2/serve.mjs — zero-dependency dev server for the kimi-web2
// design prototype: serves the static files AND proxies /api/v1 (HTTP + WS)
// to a running kimi-code server, so the app talks to it same-origin (no CORS).
//
//   node serve.mjs [--port 8101] [--target http://127.0.0.1:58627]
//
// Then open:  http://localhost:8101/?token=<server token>
// Without a token the app runs in offline stub mode (design-only).

import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = Number(arg('port', '8101'));
const TARGET = new URL(arg('target', 'http://127.0.0.1:58627'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Proxy the API to the kimi server (same-origin for the browser).
  if (url.pathname.startsWith('/api/')) {
    const opts = {
      hostname: TARGET.hostname,
      port: TARGET.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: TARGET.host },
    };
    const up = http.request(opts, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 502, msg: 'kimi server unreachable: ' + TARGET.href }));
    });
    req.pipe(up);
    return;
  }

  // Static files.
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = normalize(file).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// WebSocket proxy: forward the Upgrade handshake and pipe both sockets.
server.on('upgrade', (req, clientSocket, head) => {
  const upSocket = net.connect(Number(TARGET.port), TARGET.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = k.toLowerCase() === 'host' ? TARGET.host : req.rawHeaders[i + 1];
      lines.push(`${k}: ${v}`);
    }
    upSocket.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upSocket.write(head);
    clientSocket.pipe(upSocket);
    upSocket.pipe(clientSocket);
  });
  const kill = () => {
    clientSocket.destroy();
    upSocket.destroy();
  };
  upSocket.on('error', kill);
  clientSocket.on('error', kill);
});

server.listen(PORT, () => {
  console.log(`kimi-web2 → http://localhost:${PORT}/  (API proxied to ${TARGET.href})`);
  console.log(`open with a token: http://localhost:${PORT}/?token=<server token>`);
});
