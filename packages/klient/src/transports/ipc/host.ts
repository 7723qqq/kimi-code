/**
 * IPC host — serves one engine scope over a unix domain socket. Incoming
 * frames are bridged to the shared in-process dispatcher (the same code the
 * memory transport uses), so ipc and in-memory behavior are identical by
 * construction; only serialization separates them.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { createMemoryDispatcher, type ScopeLike } from '../memory/dispatcher.js';
import { encodeFrame, NdjsonDecoder, type IpcFrame } from './codec.js';

const REQUEST_INVALID = 40001;
const UNAUTHORIZED = 40100;

export interface ServeKlientIpcOptions {
  /** A bootstrapped engine app scope (same value `createKlient({ scope })` takes). */
  readonly scope: ScopeLike;
  /** Unix socket path to listen on. A stale socket file at the path is removed first. */
  readonly socketPath: string;
  /**
   * Optional token; when set, the client's `hello` must carry the same token.
   * When omitted, a random token is generated and exposed on the returned
   * host — the socket is never left open to every local process.
   */
  readonly token?: string;
}

export interface KlientIpcHost {
  readonly socketPath: string;
  /** The bearer token clients must send in `hello`; always set. */
  readonly token: string;
  close(): Promise<void>;
}

function scopeRefFromFrame(frame: IpcFrame): ScopeRef {
  const scope: { workspaceId?: string; sessionId?: string; agentId?: string } = {};
  if (typeof frame.workspaceId === 'string') scope.workspaceId = frame.workspaceId;
  if (typeof frame.sessionId === 'string') scope.sessionId = frame.sessionId;
  if (typeof frame.agentId === 'string') scope.agentId = frame.agentId;
  return scope;
}

function eventSourceFromFrame(frame: IpcFrame): EventSourceRef {
  if (typeof frame.service === 'string' && typeof frame.event === 'string') {
    return { kind: 'emitter', service: frame.service, event: frame.event };
  }
  if (typeof frame.event === 'string' && frame.event.length > 0) {
    return { kind: 'stream', name: frame.event };
  }
  throw new RPCError(REQUEST_INVALID, `unknown event stream: ${String(frame.event)}`);
}

export async function serveKlientIpc(options: ServeKlientIpcOptions): Promise<KlientIpcHost> {
  // The socket grants full engine control (shell execution, permission
  // changes, session deletion) to any process that can reach it — never
  // leave it token-less. Generate one when the caller did not supply it.
  const token = options.token ?? randomBytes(32).toString('hex');

  // `clone: false`: the IPC codec (`encodeFrame`) already JSON-serializes
  // every frame at the socket boundary, so the dispatcher's extra JSON
  // round-trip per value would only double the cost of large streaming
  // payloads without adding isolation the codec does not already provide.
  const dispatcher = createMemoryDispatcher(options.scope, { clone: false });

  // Best-effort cleanup of a stale socket file. Only a real socket (or a
  // missing file) is removed — a regular file at the path is a caller bug
  // and must not be deleted (e.g. a typo'd `~/.bashrc` as the socket path).
  try {
    const st = await lstat(options.socketPath);
    if (st.isSocket()) {
      await unlink(options.socketPath);
    } else {
      throw new Error(
        `refusing to remove non-socket path ${options.socketPath} (file exists and is not a socket)`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const connections = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections.add(socket);
    const decoder = new NdjsonDecoder();
    const listens = new Map<string, IDisposable>();
    const activeStreams = new Map<string, AbortController>();
    let helloDone = false;

    const send = (frame: IpcFrame): void => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };
    /**
     * Write a frame and report whether the socket's write buffer accepted it.
     * `false` means the kernel/stream buffer is full — the caller should stop
     * producing and wait for the `drain` event (see `awaitSocketDrain`).
     */
    const tryWrite = (frame: IpcFrame): boolean => {
      if (socket.destroyed) return true;
      return socket.write(encodeFrame(frame));
    };
    /** Resolve when the socket drains (buffer flushed) or is destroyed/closed. */
    const awaitSocketDrain = (): Promise<void> =>
      new Promise((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        const settle = (): void => {
          socket.off('drain', settle);
          socket.off('close', settle);
          resolve();
        };
        socket.once('drain', settle);
        socket.once('close', settle);
      });
    const sendError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const sendStreamError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'stream_error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'stream_error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: IpcFrame): void => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      switch (frame.type) {
        case 'hello': {
          // Validate against the resolved token (the caller-supplied one or the
          // generated one exposed on `host.token`). Validating `options.token`
          // instead would accept every `hello` when the caller omitted a token,
          // silently disabling the auth the generated token is meant to provide.
          if (frame.token !== token) {
            send({ type: 'error', id: 'hello', code: UNAUTHORIZED, msg: 'unauthorized' });
            socket.end();
            return;
          }
          helloDone = true;
          return;
        }
        case 'call': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          dispatcher
            .call(scopeRefFromFrame(frame), String(frame.service), String(frame.method), args)
            .then((data) => {
              send({ type: 'result', id, data });
            })
            .catch((error: unknown) => {
              sendError(id, error);
            });
          return;
        }
        case 'listen': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          try {
            const source = eventSourceFromFrame(frame);
            const sub = dispatcher.listen(
              scopeRefFromFrame(frame),
              source,
              (data) => {
                send({ type: 'event', id, data });
              },
              (error) => {
                sendError(id, error);
              },
            );
            listens.set(id, sub);
            send({ type: 'listen_result', id });
          } catch (error) {
            sendError(id, error);
          }
          return;
        }
        case 'unlisten': {
          listens.get(id)?.dispose();
          listens.delete(id);
          return;
        }
        case 'stream': {
          if (!helloDone) {
            sendStreamError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg) ? frame.arg : frame.arg === undefined ? [] : [frame.arg];
          const ac = new AbortController();
          activeStreams.set(id, ac);
          const iterable = dispatcher.stream(
            scopeRefFromFrame(frame),
            String(frame.service),
            String(frame.method),
            args,
          );
          void (async () => {
            try {
              for await (const chunk of iterable) {
                if (ac.signal.aborted || socket.destroyed) break;
                // Respect socket backpressure: when the consumer is slower
                // than the engine, `write` returns false once the buffer is
                // full — pause the pull until the socket drains instead of
                // letting the outbound buffer grow unbounded.
                if (!tryWrite({ type: 'stream_data', id, data: chunk })) {
                  await awaitSocketDrain();
                }
              }
              if (!ac.signal.aborted && !socket.destroyed) {
                send({ type: 'stream_end', id });
              }
            } catch (error) {
              if (!ac.signal.aborted && !socket.destroyed) {
                sendStreamError(id, error);
              }
            } finally {
              activeStreams.delete(id);
            }
          })();
          return;
        }
        case 'stream_cancel': {
          const ac = activeStreams.get(id);
          if (ac !== undefined) {
            ac.abort();
            activeStreams.delete(id);
          }
          return;
        }
        default:
          return;
      }
    };

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk.toString('utf8'))) {
        handleFrame(frame);
      }
    });
    const teardown = (): void => {
      for (const sub of listens.values()) sub.dispose();
      listens.clear();
      for (const ac of activeStreams.values()) ac.abort();
      activeStreams.clear();
      connections.delete(socket);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    send({ type: 'ready' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });

  return {
    socketPath: options.socketPath,
    token,
    close: () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          void unlink(options.socketPath).then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        });
      });
    },
  };
}
