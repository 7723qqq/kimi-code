/**
 * `subagent` domain — newline-delimited JSON-RPC wire for the Codex
 * app-server.
 *
 * The `codex app-server --stdio` protocol speaks one JSON-RPC message per
 * line over stdio. This wire correlates responses by id, dispatches
 * server notifications to registered handlers, and rejects pending requests
 * when the transport closes. Reused by the codex subagent backend.
 */

import { createInterface } from 'node:readline';

import type { IProcess } from '#/session/process/processRunner';

export class CodexWireClosedError extends Error {
  constructor() {
    super('codex app-server transport closed');
    this.name = 'CodexWireClosedError';
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
}

type NotificationHandler = (params: unknown) => void;

export class CodexWire {
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly process: IProcess) {
    const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim().length === 0) return;
      this.handleMessage(JSON.parse(line) as Record<string, unknown>);
    });
    lines.on('close', () => this.onTransportClosed());
    process.stdout.on('error', () => this.onTransportClosed());
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CodexWireClosedError());
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error('codex request aborted'));
      };
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        onAbort,
      });
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.write({ jsonrpc: '2.0', id, method, params });
    });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  onNotification<T>(method: string, handler: (params: T) => void): () => void {
    const handlers = this.handlers.get(method) ?? new Set<NotificationHandler>();
    const wrapped = handler as unknown as NotificationHandler;
    handlers.add(wrapped);
    this.handlers.set(method, handlers);
    return () => {
      handlers.delete(wrapped);
    };
  }

  dispose(): void {
    this.closed = true;
    this.onTransportClosed();
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message['id'] === 'number' || typeof message['id'] === 'string') {
      const pending = this.pending.get(message['id']);
      if (pending === undefined) return;
      this.pending.delete(message['id']);
      if (pending.signal !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      if (message['error'] !== undefined) {
        const raw = message['error'];
        const errorMessage =
          typeof raw === 'string'
            ? raw
            : typeof raw === 'object' &&
                raw !== null &&
                typeof (raw as { message?: unknown }).message === 'string'
              ? (raw as { message: string }).message
              : 'codex error';
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(message['result']);
      }
      return;
    }
    if (typeof message['method'] === 'string') {
      const handlers = this.handlers.get(message['method']);
      if (handlers === undefined) return;
      for (const handler of handlers) {
        handler(message['params']);
      }
    }
  }

  private onTransportClosed(): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.signal !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(new CodexWireClosedError());
      this.pending.delete(id);
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
