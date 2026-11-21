import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  BACKEND_MAX_FRAME_BYTES,
  BACKEND_PROTOCOL_VERSION,
  BackendProtocolError,
  BackendRequestError,
  backendEvents,
  backendMethods,
  parseBackendFrame,
  type BackendEvent,
  type BackendEventPayload,
  type BackendFrame,
  type BackendInput,
  type BackendMethod,
  type BackendOutput,
} from './backend-protocol';

type Role = 'electron' | 'bun';
type Handler<M extends BackendMethod> = (
  input: BackendInput<M>,
  signal: AbortSignal,
) => BackendOutput<M> | Promise<BackendOutput<M>>;
interface Pending {
  method: BackendMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class BackendChannel {
  private readonly pending = new Map<number, Pending>();
  private readonly incoming = new Map<number, AbortController>();
  private readonly cancelled = new Set<number>();
  private readonly handlers = new Map<
    BackendMethod,
    (input: unknown, signal: AbortSignal) => unknown
  >();
  private readonly events = new Map<BackendEvent, (payload: unknown) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private lastIncomingId = 0;
  private sequence = 0;
  private queuedBytes = 0;
  private failure: Error | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly role: Role,
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', this.onStreamError);
    input.once('close', this.onEnd);
    output.once('error', this.onStreamError);
  }

  get connected(): boolean {
    return this.failure === undefined;
  }

  handle<M extends BackendMethod>(method: M, handler: Handler<M>): void {
    if (backendMethods[method].receiver !== this.role || this.handlers.has(method)) {
      throw new BackendProtocolError('Invalid Desktop backend handler registration');
    }
    this.handlers.set(method, (input, signal) => handler(input as BackendInput<M>, signal));
  }

  on<E extends BackendEvent>(name: E, handler: (payload: BackendEventPayload<E>) => void): void {
    if (backendEvents[name].receiver !== this.role || this.events.has(name)) {
      throw new BackendProtocolError('Invalid Desktop backend event registration');
    }
    this.events.set(name, (payload) => handler(payload as BackendEventPayload<E>));
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    if (this.failure !== undefined) listener(this.failure);
    else this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  request<M extends BackendMethod>(
    method: M,
    input: BackendInput<M>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BackendOutput<M>> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (backendMethods[method].receiver === this.role)
      return Promise.reject(new BackendProtocolError('Invalid Desktop backend request direction'));
    if (this.pending.size >= 128)
      return Promise.reject(new Error('Desktop backend request limit exceeded'));
    if (options.signal?.aborted)
      return Promise.reject(
        new BackendRequestError('cancelled', 'Desktop backend request cancelled'),
      );
    const parsed = backendMethods[method].input.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new BackendProtocolError('Invalid Desktop backend request input'));
    const id = ++this.sequence;
    return new Promise<BackendOutput<M>>((resolve, reject) => {
      const cancel = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        if (this.cancelled.size >= 256) {
          this.fail(
            new BackendProtocolError('Too many unacknowledged Desktop backend cancellations'),
          );
        } else {
          this.cancelled.add(id);
          void this.send({ version: BACKEND_PROTOCOL_VERSION, type: 'cancel', id }).catch(
            this.fail,
          );
        }
        reject(new BackendRequestError('cancelled', 'Desktop backend request cancelled'));
      };
      const timeout = setTimeout(() => {
        cancel();
        this.fail(new Error(`Desktop backend ${method} request timed out`));
      }, options.timeoutMs ?? 30_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
      };
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as BackendOutput<M>),
        reject,
        cleanup,
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      void this.send({
        version: BACKEND_PROTOCOL_VERSION,
        type: 'request',
        id,
        method,
        input: parsed.data,
      }).catch(this.fail);
    });
  }

  emit<E extends BackendEvent>(name: E, payload: BackendEventPayload<E>): Promise<void> {
    if (backendEvents[name].receiver === this.role)
      return Promise.reject(new BackendProtocolError('Invalid Desktop backend event direction'));
    const parsed = backendEvents[name].payload.safeParse(payload);
    if (!parsed.success)
      return Promise.reject(new BackendProtocolError('Invalid Desktop backend event payload'));
    return this.send({
      version: BACKEND_PROTOCOL_VERSION,
      type: 'event',
      name,
      payload: parsed.data,
    });
  }

  drain(): Promise<void> {
    return this.writeTail;
  }

  close(error = new Error('Desktop backend channel closed')): void {
    this.fail(error);
  }

  private send(frame: BackendFrame): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const line = JSON.stringify(frame) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > BACKEND_MAX_FRAME_BYTES || this.queuedBytes + bytes > 2 * BACKEND_MAX_FRAME_BYTES) {
      const error = new BackendProtocolError('Desktop backend output exceeded its size limit');
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedBytes += bytes;
    const written = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.failure !== undefined) {
            reject(this.failure);
            return;
          }
          this.output.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.writeTail = written.finally(() => {
      this.queuedBytes -= bytes;
    });
    void this.writeTail.catch(this.fail);
    return written;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.failure !== undefined) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    try {
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > BACKEND_MAX_FRAME_BYTES)
          throw new BackendProtocolError('Desktop backend frame exceeded its size limit');
        this.receive(parseBackendFrame(line));
      }
      if (Buffer.byteLength(this.buffer) > BACKEND_MAX_FRAME_BYTES)
        throw new BackendProtocolError('Desktop backend frame exceeded its size limit');
    } catch {
      void this.send({ version: BACKEND_PROTOCOL_VERSION, type: 'protocol-error' }).catch(() => {});
      this.fail(new BackendProtocolError('Desktop backend protocol violation'));
    }
  };

  private receive(frame: BackendFrame): void {
    if (frame.type === 'protocol-error')
      throw new BackendProtocolError('Desktop backend peer rejected the protocol');
    if (frame.type === 'cancel') {
      if (frame.id > this.lastIncomingId)
        throw new BackendProtocolError('Unknown Desktop backend cancellation');
      this.incoming.get(frame.id)?.abort();
      return;
    }
    if (frame.type === 'result') {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) {
        if (this.cancelled.delete(frame.id)) return;
        throw new BackendProtocolError('Unknown or duplicate Desktop backend reply');
      }
      if (frame.ok) {
        const parsed = backendMethods[pending.method].output.safeParse(frame.value);
        if (!parsed.success) throw new BackendProtocolError('Invalid Desktop backend reply');
        this.pending.delete(frame.id);
        pending.cleanup();
        pending.resolve(parsed.data);
      } else {
        this.pending.delete(frame.id);
        pending.cleanup();
        pending.reject(new BackendRequestError(frame.error.code, frame.error.message));
      }
      return;
    }
    if (frame.type === 'event') {
      if (!Object.hasOwn(backendEvents, frame.name))
        throw new BackendProtocolError('Unknown Desktop backend event');
      const name = frame.name as BackendEvent;
      const contract = backendEvents[name];
      if (contract.receiver !== this.role)
        throw new BackendProtocolError('Invalid Desktop backend event direction');
      const parsed = contract.payload.safeParse(frame.payload);
      if (!parsed.success) throw new BackendProtocolError('Invalid Desktop backend event payload');
      const handler = this.events.get(name);
      if (handler === undefined) throw new BackendProtocolError('Unhandled Desktop backend event');
      handler(parsed.data);
      return;
    }
    if (!Object.hasOwn(backendMethods, frame.method))
      throw new BackendProtocolError('Unknown Desktop backend action');
    const method = frame.method as BackendMethod;
    const contract = backendMethods[method];
    if (
      contract.receiver !== this.role ||
      frame.id <= this.lastIncomingId ||
      this.incoming.size >= 128
    ) {
      throw new BackendProtocolError('Invalid Desktop backend request');
    }
    const parsed = contract.input.safeParse(frame.input);
    if (!parsed.success) throw new BackendProtocolError('Invalid Desktop backend request input');
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new BackendProtocolError('Unhandled Desktop backend action');
    this.lastIncomingId = frame.id;
    const abort = new AbortController();
    this.incoming.set(frame.id, abort);
    void Promise.resolve()
      .then(() => handler(parsed.data, abort.signal))
      .then((value) => {
        const result = contract.output.safeParse(value);
        if (!result.success)
          throw new BackendProtocolError('Invalid Desktop backend handler result');
        return this.send({
          version: BACKEND_PROTOCOL_VERSION,
          type: 'result',
          id: frame.id,
          ok: true,
          value: result.data,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof BackendProtocolError) {
          this.fail(error);
          return;
        }
        const failure =
          error instanceof BackendRequestError
            ? error
            : new BackendRequestError('request_failed', 'Desktop backend action failed');
        return this.send({
          version: BACKEND_PROTOCOL_VERSION,
          type: 'result',
          id: frame.id,
          ok: false,
          error: { code: failure.code, message: failure.message },
        });
      })
      .catch(this.fail)
      .finally(() => {
        this.incoming.delete(frame.id);
      });
  }

  private readonly onEnd = (): void => {
    this.fail(
      new Error(
        this.buffer.length === 0
          ? 'Desktop backend channel reached EOF'
          : 'Desktop backend channel ended with an incomplete frame',
      ),
    );
  };

  private readonly onStreamError = (): void => {
    this.fail(new Error('Desktop backend control stream failed'));
  };

  private readonly fail = (error: unknown): void => {
    if (this.failure !== undefined) return;
    this.failure = error instanceof Error ? error : new Error('Desktop backend channel failed');
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.cancelled.clear();
    for (const abort of this.incoming.values()) abort.abort();
    this.incoming.clear();
    for (const listener of this.disconnectListeners) listener(this.failure);
    this.disconnectListeners.clear();
    this.events.clear();
    this.handlers.clear();
    this.buffer = '';
    this.output.end();
  };
}
