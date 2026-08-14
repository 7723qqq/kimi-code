/**
 * `lsp` domain — JSON-RPC connection over an LSP server's stdio.
 *
 * Wraps an `IProcess` with request/notify/cancel over the LSP framing,
 * correlating responses by id. Server-initiated requests are routed to a
 * handler (the stdio provider answers `workspace/configuration` statically
 * and rejects edits). A closed transport rejects every pending request with
 * `LspTransportClosedError` so the instance layer can recover by respawning.
 */

import type { IProcess } from '#/session/process/processRunner';

import { encodeFrame, MessageDecoder } from './framing';
import type { LspMessage, LspNotificationMessage, LspRequestMessage, LspResponseMessage } from './protocol';

export class LspTransportClosedError extends Error {
  constructor() {
    super('LSP server transport closed');
    this.name = 'LspTransportClosedError';
  }
}

export class LspRequestAbortedError extends Error {
  constructor() {
    super('LSP request aborted');
    this.name = 'LspRequestAbortedError';
  }
}

export class LspServerError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`LSP server error ${code}: ${message}`);
    this.name = 'LspServerError';
    this.code = code;
  }
}

export interface LspServerRequestHandler {
  (method: string, params: unknown): Promise<unknown>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
}

export class LspConnection {
  private readonly decoder = new MessageDecoder();
  private readonly pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly process: IProcess,
    private readonly onServerRequest: LspServerRequestHandler = async () => null,
  ) {
    this.process.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.stdout.on('end', () => this.onTransportClosed());
    this.process.stdout.on('error', () => this.onTransportClosed());
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(new LspTransportClosedError());
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(new LspRequestAbortedError());
      };
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, signal, onAbort });
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

  dispose(): void {
    this.closed = true;
    this.onTransportClosed();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let messages: string[];
    try {
      messages = this.decoder.feed(chunk);
    } catch {
      this.onTransportClosed();
      return;
    }
    for (const message of messages) {
      this.handleMessage(JSON.parse(message) as LspMessage);
    }
  }

  private handleMessage(message: LspMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (pending.signal !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      if (message.error !== undefined) {
        pending.reject(new LspServerError(message.error.code, message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isRequest(message)) {
      void this.handleServerRequest(message);
      return;
    }
    // Notifications are fire-and-forget; nothing to do.
  }

  private async handleServerRequest(message: LspRequestMessage): Promise<void> {
    try {
      const result = await this.onServerRequest(message.method, message.params);
      this.write({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private onTransportClosed(): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.signal !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(new LspTransportClosedError());
      this.pending.delete(id);
    }
  }

  private write(message: LspMessage): void {
    if (this.closed) return;
    this.process.stdin.write(encodeFrame(JSON.stringify(message)));
  }
}

function isResponse(message: LspMessage): message is LspResponseMessage {
  return 'id' in message && ('result' in message || 'error' in message);
}

function isRequest(message: LspMessage): message is LspRequestMessage {
  return 'id' in message && 'method' in message && !('result' in message) && !('error' in message);
}

export type { LspNotificationMessage };
