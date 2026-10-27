import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Covers the RESP commands and parser paths not exercised by server.test.ts.
import { describe, expect, it, test } from 'bun:test';

import { ParsedCommand, RespParser, startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv2-'));
}

function encode(...args: string[]) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function send(sock: net.Socket, cmd: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

// Send a command and resolve when the server closes the connection (QUIT).
function sendUntilClose(sock: net.Socket, cmd: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    sock.once('close', () => resolve());
    sock.write(cmd);
  });
}

test('RESP: ECHO and PING with argument', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('ECHO', 'hello'))).toBe('$5\r\nhello\r\n');
    expect(await send(sock, encode('PING', 'hi'))).toBe('$2\r\nhi\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: EXISTS / MSET / MGET / TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('MSET', 'a', '1', 'b', '2'))).toBe('+OK\r\n');
    expect(await send(sock, encode('EXISTS', 'a'))).toBe(':1\r\n');
    expect(await send(sock, encode('EXISTS', 'z'))).toBe(':0\r\n');
    expect(await send(sock, encode('MGET', 'a', 'b'))).toBe('*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
    // TTL must keep the Redis sentinels instead of dividing them by 1000
    // (`Math.trunc(-1 / 1000)` is `-0`, which the wire prints as `:0`, so a
    // missing key and a key with no expiry both looked like "expires now").
    expect(await send(sock, encode('TTL', 'nosuchkey'))).toBe(':-2\r\n');
    expect(await send(sock, encode('TTL', 'a'))).toBe(':-1\r\n');
    // A live TTL is reported in whole seconds, rounded (not truncated) to the
    // nearest one the way Redis does: `PX 1600` is already at ~1599 ms when it
    // is read back, so truncation answers `:1` for a key with ~2 s left.
    expect(await send(sock, encode('SET', 'px', 'v', 'PX', '1600'))).toBe('+OK\r\n');
    expect(await send(sock, encode('TTL', 'px'))).toBe(':2\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: MSET rejects an odd argument count without writing anything', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // A trailing key without a value used to be dropped silently and the
    // command still answered +OK, so a truncated pipeline looked like a
    // successful atomic batch. Nothing may be written when the arity is wrong.
    expect(String(await send(sock, encode('MSET', 'k1', 'v1', 'k2')))).toMatch(/^-ERR wrong number of arguments/);
    expect(await send(sock, encode('GET', 'k1'))).toBe('$-1\r\n');
    expect(await send(sock, encode('GET', 'k2'))).toBe('$-1\r\n');
    expect(String(await send(sock, encode('MSET')))).toMatch(/^-ERR wrong number of arguments/);
    // The even form is still an atomic batch.
    expect(await send(sock, encode('MSET', 'k1', 'v1', 'k2', 'v2'))).toBe('+OK\r\n');
    expect(await send(sock, encode('MGET', 'k1', 'k2'))).toBe('*2\r\n$2\r\nv1\r\n$2\r\nv2\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: SET with EX / PX sets a TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    expect(await send(sock, encode('SET', 'ex', 'v', 'EX', '10'))).toBe('+OK\r\n');
    const ex = Number((await send(sock, encode('TTL', 'ex'))).slice(1));
    expect(ex > 0 && ex <= 10, `EX ttl=${ex}`).toBeTruthy();

    expect(await send(sock, encode('SET', 'px', 'v', 'PX', '5000'))).toBe('+OK\r\n');
    const px = Number((await send(sock, encode('TTL', 'px'))).slice(1));
    expect(px > 0 && px <= 5, `PX ttl=${px}`).toBeTruthy();
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: INFO and COMPACT', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'k', 'v'));
    const info = await send(sock, encode('INFO'));
    expect(info.includes('minidb_version:0.0.1'), info).toBeTruthy();
    expect(info.includes('keys:1'), info).toBeTruthy();
    expect(await send(sock, encode('COMPACT'))).toBe('+OK\r\n');
    const info2 = await send(sock, encode('INFO'));
    expect(info2.includes('compactions:1'), info2).toBeTruthy();
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: QUIT closes the connection', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await expect(sendUntilClose(sock, encode('QUIT'))).resolves.toBeUndefined();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: inline (non-array) command path', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // Redis inline protocol: a bare line of space-separated tokens.
    expect(await send(sock, 'PING\r\n')).toBe('+PONG\r\n');
    expect(await send(sock, 'SET foo bar\r\n')).toBe('+OK\r\n');
    expect(await send(sock, 'GET foo\r\n')).toBe('$3\r\nbar\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Accumulate reply bytes until `done` accepts them (replies may span chunks).
function collectUntil(sock: net.Socket, done: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for reply; got ${buf.length} bytes`)),
      20_000,
    );
    sock.on('data', (d) => {
      buf += d.toString();
      if (done(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
  });
}

test('RESP: a client aborting mid-large-reply does not kill the server', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    sock.on('error', () => {}); // the test client itself may see the RST
    const big = 'x'.repeat(4 * 1024 * 1024);
    expect(await send(sock, encode('SET', 'big', big))).toBe('+OK\r\n');
    // Ask for the large value, then reset the connection without reading the
    // reply: the server hits EPIPE/ECONNRESET while writing it out.
    sock.write(encode('GET', 'big'));
    await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    // Give the server a moment to hit the write failure, then prove a fresh
    // connection is still being served.
    await new Promise((r) => setTimeout(r, 100));
    const sock2 = await connect(srv.port);
    expect(await send(sock2, encode('PING'))).toBe('+PONG\r\n');
    sock2.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  'RESP: an oversized request gets -ERR and the connection recovers',
  { timeout: 30_000 },
  async () => {
    const dir = await tmpDir();
    const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
    try {
      const sock = await connect(srv.port);
      // 65MB of bulk payload crosses the parser's 64MB cap.
      const big = Buffer.alloc(65 * 1024 * 1024, 'x'.charCodeAt(0));
      const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${big.length}\r\n`);
      sock.write(Buffer.concat([head, big, Buffer.from('\r\n')]));
      // Pipelined right behind it: once the parser recovers from the -ERR this
      // fresh small command must still be answered.
      sock.write(encode('PING'));
      const data = await collectUntil(sock, (s) => s.includes('+PONG'));
      const tooLarge = data.indexOf('too large');
      const pong = data.indexOf('+PONG');
      expect(tooLarge !== -1, `expected a too-large -ERR, got ${JSON.stringify(data.slice(0, 120))}`).toBeTruthy();
      expect(pong > tooLarge, 'PING after the oversized request must be answered').toBeTruthy();
      sock.end();
    } finally {
      await srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('RESP: one bad command does not starve its pipelined siblings', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // The 129-byte key exceeds MAX_KEY_LEN so SET throws inside the handler;
    // the two PINGs in the very same chunk must still be answered, in order.
    const key = 'k'.repeat(129);
    sock.write(encode('SET', key, 'v') + encode('PING') + encode('PING'));
    const data = await collectUntil(sock, (s) => s.endsWith('+PONG\r\n+PONG\r\n'));
    expect(String(data)).toMatch(/^-ERR [^\r]*\r\n\+PONG\r\n\+PONG\r\n$/);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── RespParser oversized-request handling (unit level, small caps) ──────────

describe('RespParser oversized requests', () => {
  function feedAll(parser: RespParser, chunks: Buffer[]): ParsedCommand[] {
    const out: ParsedCommand[] = [];
    for (const c of chunks) out.push(...parser.feed(c));
    return out;
  }

  it('rejects from the declared bulk length before the payload arrives', () => {
    const p = new RespParser({ maxBuf: 1024 });
    const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2048\r\n`);
    const first = feedAll(p, [Buffer.concat([head, Buffer.alloc(100)])]);
    expect(first.length).toBe(1);
    expect(first[0]!.kind).toBe('error');
    expect(String(first[0]!.message)).toMatch(/too large/);
  });

  it('skips a rejected payload split across chunks and answers what follows', () => {
    const p = new RespParser({ maxBuf: 1024 });
    const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2048\r\n`);
    const rest = Buffer.alloc(2048 + 2);
    const ping = Buffer.from(encode('PING'));
    const out = feedAll(p, [
      Buffer.concat([head, rest.subarray(0, 500)]),
      rest.subarray(500),
      ping,
    ]);
    expect(out.map((r) => r.kind)).toStrictEqual(['error', 'command']);
    expect(String(out[0]!.message)).toMatch(/too large/);
    expect(out[1].kind === 'command' && out[1].args[0]?.toString()).toBe('PING');
  });

  it('keeps pipelined commands that arrive in the same chunk as the payload', () => {
    const p = new RespParser({ maxBuf: 1024 });
    const whole = Buffer.concat([
      Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2048\r\n`),
      Buffer.alloc(2048 + 2),
      Buffer.from(encode('PING')),
    ]);
    const out = [...p.feed(whole)];
    expect(out.map((r) => r.kind)).toStrictEqual(['error', 'command']);
  });

  it('still backstops unheadered floods that exceed the buffer cap', () => {
    const p = new RespParser({ maxBuf: 64 });
    const out = feedAll(p, [Buffer.alloc(65, 'x'.charCodeAt(0))]);
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe('error');

    // The buffer was dropped, so fresh commands parse normally again.
    const after = [...p.feed(Buffer.from(encode('PING')))];
    expect(after[0]!.kind === 'command' && after[0].args[0]?.toString()).toBe('PING');
  });
});
