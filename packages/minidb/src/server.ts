// src/server.ts
//
// A minimal RESP (REdis Serialization Protocol) TCP front-end for MiniDb, so
// existing Redis clients (redis-cli, ioredis, ...) can talk to it.

import net from 'node:net';
import type { Socket } from 'node:net';
import { MiniDb } from './index.js';

const CRLF = '\r\n';
const NIL = `$-1${CRLF}`;

const reply = {
  ok: () => `+OK${CRLF}`,
  pong: () => `+PONG${CRLF}`,
  int: (n: number) => `:${n}${CRLF}`,
  err: (m: string) => `-ERR ${m}${CRLF}`,
  // Bulk replies carry raw bytes. Build a Buffer so non-ASCII / binary values
  // are written verbatim instead of being re-encoded as UTF-8 (which corrupted
  // them and desynced the protocol when `socket.write(string)` defaulted to
  // utf8).
  bulk: (v: unknown): Buffer => {
    if (v === undefined || v === null) return Buffer.from(NIL);
    const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v as string));
    return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
  },
  array: (items: unknown[]): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${items.length}${CRLF}`)];
    for (const it of items) parts.push(reply.bulk(it));
    return Buffer.concat(parts);
  },
};

export type ParsedCommand =
  | { readonly kind: 'command'; readonly args: Buffer[] }
  | { readonly kind: 'error'; readonly message: string };

export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBuf: number;
  /** Payload bytes of a rejected oversized request still to be discarded. */
  private skipping = 0;

  constructor({ maxBuf = 64 * 1024 * 1024 }: { maxBuf?: number } = {}) {
    this.maxBuf = maxBuf;
  }

  *feed(chunk: Buffer): Generator<ParsedCommand> {
    // Discard the payload tail of a previously rejected oversized request
    // before parsing: its declared bulk length said exactly how much to skip,
    // so the pipelined commands behind it still arrive intact.
    if (this.skipping > 0) {
      const drop = Math.min(this.skipping, chunk.length);
      this.skipping -= drop;
      chunk = chunk.subarray(drop);
      if (chunk.length === 0) return;
    }
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length > 0) {
      const parsed = this.tryParse();
      if (!parsed) break;
      yield parsed;
    }
    // Backstop for requests with no skippable length header (inline commands,
    // corrupt streams): buffered data parsing cannot consume must not grow
    // past the cap. Without the reset every later chunk would fail with the
    // same error and the giant buffer would be retained for the life of the
    // connection.
    if (this.buf.length > this.maxBuf) {
      this.buf = Buffer.alloc(0);
      yield { kind: 'error', message: `RESP request too large (>${this.maxBuf} bytes)` };
    }
  }

  private tryParse(): ParsedCommand | null {
    if (this.buf[0] !== 0x2a /* '*' */) {
      const idx = this.buf.indexOf(CRLF);
      if (idx === -1) return null;
      const line = this.buf.subarray(0, idx).toString();
      this.buf = this.buf.subarray(idx + 2);
      return {
        kind: 'command',
        args: line.split(' ').filter(Boolean).map((s) => Buffer.from(s)),
      };
    }

    let pos = 1;
    let end = this.buf.indexOf(CRLF, pos);
    if (end === -1) return null;
    const argc = Number(this.buf.subarray(pos, end).toString());
    pos = end + 2;

    const args: Buffer[] = [];
    for (let i = 0; i < argc; i++) {
      if (pos >= this.buf.length || this.buf[pos] !== 0x24 /* '$' */) return null;
      pos++;
      end = this.buf.indexOf(CRLF, pos);
      if (end === -1) return null;
      const len = Number(this.buf.subarray(pos, end).toString());
      pos = end + 2;
      if (len > this.maxBuf) {
        // Reject from the declared length alone — buffer nothing. Skip the
        // payload (and its CRLF) so the next pipelined command still parses.
        const available = this.buf.length - pos;
        const needed = len + 2;
        if (available < needed) {
          this.skipping = needed - available;
          this.buf = Buffer.alloc(0);
        } else {
          this.buf = this.buf.subarray(pos + needed);
        }
        return {
          kind: 'error',
          message: `RESP request too large (bulk ${len} > ${this.maxBuf} bytes)`,
        };
      }
      if (this.buf.length - pos < len + 2) return null;
      args.push(this.buf.subarray(pos, pos + len));
      pos += len + 2;
    }
    this.buf = this.buf.subarray(pos);
    return { kind: 'command', args };
  }
}

async function handle(db: MiniDb<string>, args: Buffer[]): Promise<string | Buffer | null> {
  const cmd = args[0]?.toString().toUpperCase();
  if (cmd === undefined) return reply.err('empty command');
  const S = (i: number): string | undefined => (args[i] === undefined ? undefined : args[i]!.toString());

  switch (cmd) {
    case 'PING':
      return args[1] ? reply.bulk(S(1)) : reply.pong();
    case 'ECHO':
      return reply.bulk(S(1));
    case 'GET': {
      const key = S(1);
      if (key === undefined) return reply.err("wrong number of arguments for 'get'");
      return reply.bulk(db.get(key) ?? null);
    }
    case 'SET': {
      const key = S(1);
      const val = S(2);
      if (key === undefined || val === undefined) return reply.err("wrong number of arguments for 'set'");
      let ttl: number | undefined;
      for (let i = 3; i < args.length; i++) {
        const opt = S(i)!.toUpperCase();
        if (opt === 'EX') ttl = Number(S(++i)) * 1000;
        else if (opt === 'PX') ttl = Number(S(++i));
      }
      await db.set(key, val, ttl ? { ttl } : {});
      return reply.ok();
    }
    case 'DEL': {
      let n = 0;
      for (let i = 1; i < args.length; i++) if (await db.del(S(i)!)) n++;
      return reply.int(n);
    }
    case 'EXISTS': {
      const key = S(1);
      if (key === undefined) return reply.err("wrong number of arguments for 'exists'");
      return reply.int(db.has(key) ? 1 : 0);
    }
    case 'MGET': {
      const out: unknown[] = [];
      for (let i = 1; i < args.length; i++) {
        const v = db.get(S(i)!);
        out.push(v ?? null);
      }
      return reply.array(out);
    }
    case 'MSET': {
      const entries: (readonly [string, string])[] = [];
      for (let i = 1; i + 1 < args.length; i += 2) entries.push([S(i)!, S(i + 1)!]);
      await db.mset(entries); // atomic batch (single WAL frame), like Redis MSET
      return reply.ok();
    }
    case 'TTL': {
      const key = S(1);
      if (key === undefined) return reply.err("wrong number of arguments for 'ttl'");
      return reply.int(Math.trunc(db.ttl(key) / 1000));
    }
    case 'DBSIZE':
      return reply.int(db.size);
    case 'COMPACT':
      await db.compact();
      return reply.ok();
    case 'INFO':
      return reply.bulk(`minidb_version:0.0.1${CRLF}keys:${db.size}${CRLF}compactions:${db.stats.compactions}${CRLF}`);
    case 'QUIT':
      return null;
    default:
      return reply.err(`unknown command '${cmd}'`);
  }
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  fsyncPolicy?: 'always' | 'everysec' | 'no';
}

export interface ServerHandle {
  server: net.Server;
  db: MiniDb<string>;
  close: () => Promise<void>;
  port: number;
  host: string;
}

export async function startServer({ dir, port = 6379, host = '127.0.0.1', fsyncPolicy = 'everysec' }: ServerOptions): Promise<ServerHandle> {
  const db = (await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy })) as MiniDb<string>;
  const server = net.createServer((socket: Socket) => {
    const parser = new RespParser();
    // Serialize per-connection processing: a new chunk's commands are queued
    // behind the previous chunk's in-flight work, so replies always leave in
    // request order. Without this, a slow command in one packet (e.g. SET with
    // fsync 'always') let replies from the next packet overtake it, breaking
    // pipelined clients.
    let queue: Promise<void> = Promise.resolve();
    // A client that resets the connection while a large reply is being written
    // makes the next write fail with EPIPE/ECONNRESET. Without an 'error'
    // listener that event becomes an uncaught exception and takes the whole
    // process down, so swallow it: the connection is dead either way, and the
    // queued work below skips further writes to it.
    socket.on('error', () => {});
    // Never write to a destroyed socket: write-after-destroy would just
    // surface as another 'error' event on the dead connection.
    const send = (res: string | Buffer): void => {
      if (!socket.destroyed) socket.write(res);
    };
    socket.on('data', (chunk: Buffer) => {
      queue = queue.then(async () => {
        try {
          for (const parsed of parser.feed(chunk)) {
            if (socket.destroyed) return;
            let res: string | Buffer | null;
            if (parsed.kind === 'error') {
              res = reply.err(parsed.message);
            } else {
              try {
                // One failing command must not starve the replies of the
                // commands already parsed from the same chunk.
                res = await handle(db, parsed.args);
              } catch (error) {
                res = reply.err((error as Error).message);
              }
            }
            if (res === null) {
              socket.end();
              return;
            }
            send(res);
          }
        } catch (error) {
          send(reply.err((error as Error).message));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as net.AddressInfo).port;

  const close = async (): Promise<void> => {
    server.close();
    await db.close();
  };
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  return { server, db, close, port: actualPort, host };
}

// Run directly: node --import tsx src/server.ts --dir ./data --port 6379
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i === -1 ? undefined : argv[i + 1];
    return v ?? def;
  };
  const dir = arg('dir', './data');
  const port = Number(arg('port', '6379'));
  const fsyncPolicy = arg('fsync', 'everysec') as 'always' | 'everysec' | 'no';
  const { host, port: p } = await startServer({ dir, port, fsyncPolicy });
  console.log(`minidb RESP server listening on ${host}:${p} (dir=${dir}, fsync=${fsyncPolicy})`);
}
