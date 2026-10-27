import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// test/server.test.ts
import { expect, test } from 'bun:test';

import { startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv-'));
}

function encode(...args) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Send one command and resolve with the next response chunk.
function send(sock, cmd) {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

test('RESP server: PING / SET / GET', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('PING'))).toBe('+PONG\r\n');
    expect(await send(sock, encode('SET', 'foo', 'bar'))).toBe('+OK\r\n');
    expect(await send(sock, encode('GET', 'foo'))).toBe('$3\r\nbar\r\n');
    expect(await send(sock, encode('GET', 'missing'))).toBe('$-1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP server: MGET / DEL / DBSIZE', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'a', '1'));
    await send(sock, encode('SET', 'b', '2'));
    expect(await send(sock, encode('MGET', 'a', 'b', 'z'))).toBe('*3\r\n$1\r\n1\r\n$1\r\n2\r\n$-1\r\n');
    expect(await send(sock, encode('DBSIZE'))).toBe(':2\r\n');
    expect(await send(sock, encode('DEL', 'a'))).toBe(':1\r\n');
    expect(await send(sock, encode('DBSIZE'))).toBe(':1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP server: unknown command returns an error', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    const r = await send(sock, encode('NOPE'));
    expect(r.startsWith('-ERR')).toBeTruthy();
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// `SET k v EX abc` used to answer +OK and store the key forever: `ttl ? {ttl} : {}`
// turned NaN into "no expiry". A bad EX/PX must now be an error, not a silent no-op.
test('RESP server: SET rejects a non-finite or negative EX/PX', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect((await send(sock, encode('SET', 'k', 'v', 'EX', 'abc'))).startsWith('-ERR')).toBeTruthy();
    expect((await send(sock, encode('SET', 'k', 'v', 'PX', '-1'))).startsWith('-ERR')).toBeTruthy();
    expect((await send(sock, encode('SET', 'k', 'v', 'EX', 'NaN'))).startsWith('-ERR')).toBeTruthy();
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// `SET k v NX` / `XX` / `GET` / `KEEPTTL` used to be accepted and ignored: the
// write went through unconditionally, so `SET lock owner NX EX 30` overwrote
// someone else's value and still answered +OK. Unsupported options must now be
// rejected before the write, and a misspelled token must not be silently taken
// as "no options".
test('RESP server: SET rejects unsupported or unknown options without writing', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('SET', 'k', 'v1'))).toBe('+OK\r\n');

    expect(String(await send(sock, encode('SET', 'k', 'v2', 'NX')))).toMatch(/^-ERR .*nx/);
    expect(await send(sock, encode('GET', 'k'))).toBe('$2\r\nv1\r\n');

    expect(String(await send(sock, encode('SET', 'fresh', 'v', 'XX')))).toMatch(/^-ERR .*xx/);
    expect(await send(sock, encode('EXISTS', 'fresh'))).toBe(':0\r\n');

    expect(String(await send(sock, encode('SET', 'k', 'v3', 'KEEPTTL')))).toMatch(/^-ERR .*keepttl/);
    expect(String(await send(sock, encode('SET', 'k', 'v4', 'GET')))).toMatch(/^-ERR .*get/);
    expect(await send(sock, encode('GET', 'k'))).toBe('$2\r\nv1\r\n');

    // A rejected KEEPTTL must not have been applied as "clear the TTL": the
    // rejected request leaves both the value and the existing expiry alone.
    expect(await send(sock, encode('SET', 'ttlkey', 'v', 'EX', '100'))).toBe('+OK\r\n');
    expect(String(await send(sock, encode('SET', 'ttlkey', 'v2', 'KEEPTTL')))).toMatch(/^-ERR .*keepttl/);
    const kept = Number((await send(sock, encode('TTL', 'ttlkey'))).slice(1));
    expect(kept > 0 && kept <= 100, `TTL after a rejected KEEPTTL = ${kept}`).toBeTruthy();
    expect(await send(sock, encode('GET', 'ttlkey'))).toBe('$1\r\nv\r\n');

    expect(String(await send(sock, encode('SET', 'k', 'v5', 'BOGUS')))).toMatch(/^-ERR syntax error/);
    expect(await send(sock, encode('GET', 'k'))).toBe('$2\r\nv1\r\n');

    // A dangling EX/PX still goes through the same validation, and a rejected
    // trailing option means the whole command wrote nothing.
    expect((await send(sock, encode('SET', 'k', 'v6', 'EX'))).startsWith('-ERR')).toBeTruthy();
    expect((await send(sock, encode('SET', 'k', 'v7', 'EX', '10', 'BOGUS'))).startsWith('-ERR')).toBeTruthy();
    expect(await send(sock, encode('GET', 'k'))).toBe('$2\r\nv1\r\n');
    expect(await send(sock, encode('TTL', 'k'))).toBe(':-1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// `SET k v PX 0` passed validation and then `ttl ? {ttl} : {}` dropped the zero,
// so the caller got +OK and a key that never expires. Redis rejects a zero
// expire time; so must we.
test('RESP server: SET rejects a zero EX/PX instead of storing forever', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(String(await send(sock, encode('SET', 'px0', 'v', 'PX', '0')))).toMatch(/^-ERR invalid expire time/);
    expect(await send(sock, encode('GET', 'px0'))).toBe('$-1\r\n');
    expect(await send(sock, encode('TTL', 'px0'))).toBe(':-2\r\n');

    expect(String(await send(sock, encode('SET', 'ex0', 'v', 'EX', '0')))).toMatch(/^-ERR invalid expire time/);
    expect(await send(sock, encode('GET', 'ex0'))).toBe('$-1\r\n');

    // The valid cases keep working and still expire. `PX 1600` (not 1000)
    // because the reply must round to the nearest second: truncating the
    // remaining ~1599 ms would answer `:1` here and `:0` for `PX 1000`.
    expect(await send(sock, encode('SET', 'px', 'v', 'PX', '1600'))).toBe('+OK\r\n');
    expect(await send(sock, encode('TTL', 'px'))).toBe(':2\r\n');
    expect(await send(sock, encode('SET', 'ex', 'v', 'EX', '1'))).toBe('+OK\r\n');
    await new Promise((r) => setTimeout(r, 1100));
    expect(await send(sock, encode('GET', 'ex'))).toBe('$-1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The counterpart: a valid TTL is still accepted and actually expires the key.
test('RESP server: SET honors a valid EX', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('SET', 'k', 'v', 'EX', '1'))).toBe('+OK\r\n');
    expect(await send(sock, encode('GET', 'k'))).toBe('$1\r\nv\r\n');
    await new Promise((r) => setTimeout(r, 1100));
    expect(await send(sock, encode('GET', 'k'))).toBe('$-1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
