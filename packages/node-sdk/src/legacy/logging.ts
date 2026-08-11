/**
 * Localized port of v1's diagnostic logger (`agent-core/src/logging/`):
 * the `Logger` contract, the root logger with its rotating global sink, the
 * entry formatter (redaction + clipping), and the `log` singleton. Copied so
 * the SDK keeps its public logging surface (`log` / `flushDiagnosticLogs` /
 * `Logger` & friends) without importing `agent-core`; keep it byte-identical
 * to the v1 original.
 *
 * Trimmed vs the v1 original: the per-session log routing
 * (`RootLogger.attachSession` and the session-sink machinery) is dropped —
 * nothing in the SDK surface attaches session logs after the v1 client's
 * removal (the v2 engine owns its own session logs), so entries carrying a
 * `sessionId` context fall through to the global sink exactly like v1's
 * un-routed entries. `resolveGlobalLogPath` / `resolveLoggingConfig` come
 * from `@moonshot-ai/agent-core-v2` (identical shape and values); `pathe` →
 * `node:path`.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

/**
 * Second argument to `log.error / warn / info / debug`.
 *
 * Three usage shapes, detected at runtime:
 *   - `Error`     → stack is extracted onto the entry
 *   - `LogContext` (object) → merged into entry context; if it contains
 *                              `{ error: Error }`, that field is pulled out
 *                              and its stack extracted (bunyan-style)
 *   - `unknown`   → typically a `catch` binding; treated as an Error if
 *                    it's an Error instance, otherwise stringified into a
 *                    `reason` field
 */
export type LogPayload = unknown;

export interface Logger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  /**
   * Returns a new logger that adds `ctx` to every entry it emits. The bound
   * context wins over per-call payload context, so callers can't accidentally
   * overwrite ownership fields like `sessionId` / `agentId`:
   *
   *   finalCtx = { ...payloadCtx, ...boundCtx }
   *
   * Children chain — `parent.createChild({a: 1}).createChild({b: 2})` binds
   * both.
   */
  createChild(ctx: LogContext): Logger;
}

export interface LogEntry {
  readonly t: number;
  readonly level: Exclude<LogLevel, 'off'>;
  readonly msg: string;
  readonly ctx?: LogContext | undefined;
  readonly error?: { readonly message: string; readonly stack?: string } | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionLogId?: string | undefined;
}

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly globalLogPath: string;
  readonly globalMaxBytes: number;
  readonly globalFiles: number;
  readonly sessionMaxBytes: number;
  readonly sessionFiles: number;
}

export interface RootLogger {
  configure(config: LoggingConfig): Promise<void>;
  /** False if any sink could not flush its pending batch. */
  flush(): Promise<boolean>;
  flushSync(): void;
  isConfigured(): boolean;
  getConfig(): LoggingConfig | undefined;
}

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function levelEnabled(threshold: LogLevel, level: Exclude<LogLevel, 'off'>): boolean {
  return LOG_LEVEL_RANK[threshold] >= LOG_LEVEL_RANK[level];
}

const ROOT_SYMBOL = Symbol.for('kimi.logger.root');

class RootLoggerImpl implements RootLogger {
  private config: LoggingConfig | undefined;
  private globalSink: RotatingFileSink | undefined;

  isConfigured(): boolean {
    return this.config !== undefined;
  }

  getConfig(): LoggingConfig | undefined {
    return this.config;
  }

  configure(config: LoggingConfig): Promise<void> {
    if (this.config !== undefined && sameLoggingConfig(this.config, config)) {
      return Promise.resolve();
    }
    const oldGlobalSink = this.globalSink;
    this.config = config;
    this.globalSink = makeGlobalSink(config);
    return oldGlobalSink?.close() ?? Promise.resolve();
  }

  async flush(): Promise<boolean> {
    if (this.globalSink === undefined) return true;
    return this.globalSink.flush();
  }

  flushSync(): void {
    this.globalSink?.flushSync();
  }

  emit(entry: LogEntry): void {
    const config = this.config;
    if (config === undefined || config.level === 'off') return;
    if (!levelEnabled(config.level, entry.level)) return;

    const formatted = formatEntry(entry);
    if (formatted.dropped) return;
    this.globalSink?.enqueue(formatted.text + '\n');
  }

  /** @internal — vitest only. */
  async __shutdownForTest(): Promise<void> {
    const closes: Promise<void>[] = [];
    if (this.globalSink !== undefined) closes.push(this.globalSink.close());
    this.globalSink = undefined;
    this.config = undefined;
    await Promise.allSettled(closes);
  }
}

function getRootInternal(): RootLoggerImpl {
  const globalAny = globalThis as Record<symbol, unknown>;
  const existing = globalAny[ROOT_SYMBOL];
  if (existing instanceof RootLoggerImpl) return existing;
  const fresh = new RootLoggerImpl();
  globalAny[ROOT_SYMBOL] = fresh;
  return fresh;
}

export function getRootLogger(): RootLogger {
  return getRootInternal();
}

export function flushDiagnosticLogs(): Promise<boolean> {
  return getRootInternal().flush();
}

/**
 * Synchronous variant for crash / emergency-exit paths that call
 * `process.exit()` on the same tick: pending entries are appended with
 * `appendFileSync`, so they survive the immediate exit that would otherwise
 * drop everything still sitting in the async queue.
 */
export function flushDiagnosticLogsSync(): void {
  getRootInternal().flushSync();
}

class LoggerImpl implements Logger {
  constructor(private readonly boundCtx: LogContext) {}

  error(message: string, payload?: LogPayload): void {
    this.emitAt('error', message, payload);
  }
  warn(message: string, payload?: LogPayload): void {
    this.emitAt('warn', message, payload);
  }
  info(message: string, payload?: LogPayload): void {
    this.emitAt('info', message, payload);
  }
  debug(message: string, payload?: LogPayload): void {
    this.emitAt('debug', message, payload);
  }

  createChild(ctx: LogContext): Logger {
    return new LoggerImpl({ ...this.boundCtx, ...ctx });
  }

  private emitAt(
    level: Exclude<LogLevel, 'off'>,
    message: string,
    payload: LogPayload,
  ): void {
    const root = getRootInternal();
    if (!root.isConfigured()) return;
    try {
      const { ctx: payloadCtx, error } = resolvePayload(payload);
      // Bound ctx wins so call-site can't overwrite ownership fields.
      const ctx = mergeCtx(payloadCtx, this.boundCtx);
      const sessionId = ctx?.['sessionId'];
      root.emit({
        t: Date.now(),
        level,
        msg: message,
        ctx,
        error,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      });
    } catch {
      // Diagnostic logging is best-effort and must never affect main control flow.
    }
  }
}

function makeGlobalSink(config: LoggingConfig): RotatingFileSink | undefined {
  if (config.level === 'off') return undefined;
  return new RotatingFileSink({
    path: config.globalLogPath,
    maxBytes: config.globalMaxBytes,
    files: config.globalFiles,
  });
}

function sameLoggingConfig(a: LoggingConfig, b: LoggingConfig): boolean {
  return (
    a.level === b.level &&
    a.globalLogPath === b.globalLogPath &&
    a.globalMaxBytes === b.globalMaxBytes &&
    a.globalFiles === b.globalFiles &&
    a.sessionMaxBytes === b.sessionMaxBytes &&
    a.sessionFiles === b.sessionFiles
  );
}

function resolvePayload(
  payload: LogPayload,
): { ctx: LogContext | undefined; error: LogEntry['error'] } {
  if (payload === undefined || payload === null) {
    return { ctx: undefined, error: undefined };
  }
  if (payload instanceof Error) {
    return { ctx: undefined, error: extractError(payload) };
  }
  if (typeof payload === 'object') {
    // bunyan-style: a `{ error: Error }` field is hoisted out, stack extracted.
    const obj = payload as Record<string, unknown>;
    if (obj['error'] instanceof Error) {
      const { error: errValue, ...rest } = obj;
      return { ctx: rest as LogContext, error: extractError(errValue) };
    }
    return { ctx: obj as LogContext, error: undefined };
  }
  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean' ||
    typeof payload === 'bigint' ||
    typeof payload === 'symbol'
  ) {
    return { ctx: { reason: String(payload) }, error: undefined };
  }
  if (typeof payload === 'function') {
    const reason = payload.name === '' ? '[Function]' : `[Function: ${payload.name}]`;
    return { ctx: { reason }, error: undefined };
  }
  return { ctx: { reason: Object.prototype.toString.call(payload) }, error: undefined };
}

function mergeCtx(
  payloadCtx: LogContext | undefined,
  boundCtx: LogContext,
): LogContext | undefined {
  const boundHasKeys = Object.keys(boundCtx).length > 0;
  if (!boundHasKeys) return payloadCtx;
  if (payloadCtx === undefined) return { ...boundCtx };
  return { ...payloadCtx, ...boundCtx };
}

/**
 * Root logger. Import and use directly for events that don't belong to any
 * session (CLI startup, harness construction, etc.):
 *
 *   import { log } from 'kimi-code-sdk';
 *   log.info('kimi-code starting', { version });
 *
 * Late-binding: methods look up the current `RootLogger` on every call, so
 * importing `log` at module load (before the host configures the root) is
 * safe — calls during the pre-configure window are silent noops.
 */
export const log: Logger = new LoggerImpl({});

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return redactCtx({ value: value as unknown })['value'] as T;
}

/** @internal — vitest only. */
export async function __resetRootLoggerForTest(): Promise<void> {
  const globalAny = globalThis as Record<symbol, unknown>;
  const existing = globalAny[ROOT_SYMBOL];
  if (existing instanceof RootLoggerImpl) {
    await existing.__shutdownForTest();
  }
  globalAny[ROOT_SYMBOL] = undefined;
}

/* ------------------------------------------------------------------ */
/*  Formatter (port of `agent-core/src/logging/formatter.ts`)          */
/* ------------------------------------------------------------------ */

export const MSG_MAX_CHARS = 200;
export const CTX_VALUE_MAX_CHARS = 2048;
export const STACK_MAX_BYTES = 2048;
export const ENTRY_MAX_BYTES = 4096;
export const REDACT_MAX_DEPTH = 10;

const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'apikey',
  'token',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'password',
  'secret',
  'clientsecret',
  'apisecret',
  'cookie',
  'setcookie',
  'bearer',
]);

const SAFE_KEY_RE = /^[\w.-]+$/;
const ELLIPSIS = '…';
const TRUNCATED_TAIL = ` …truncated`;
const REDACTED = '[REDACTED]';
const RAW_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi,
  /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
];

const LEVEL_LABEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
};

const ANSI_LEVEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: '\u001B[31m',
  warn: '\u001B[33m',
  info: '\u001B[36m',
  debug: '\u001B[90m',
};
const ANSI_RESET = '\u001B[0m';

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_\-.]/g, '');
}

export function redactCtx(ctx: LogContext): LogContext {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH) return '[REDACTED:depth]';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[REDACTED:cycle]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(normalizeKey(key))
        ? REDACTED
        : walk(raw, depth + 1);
    }
    return out;
  };
  return walk(ctx, 0) as LogContext;
}

export interface FormatOptions {
  readonly ansi?: boolean | undefined;
  readonly omitContextKeys?: readonly string[];
}

export interface FormattedEntry {
  readonly text: string;
  readonly dropped: boolean;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + ELLIPSIS;
}

function serializeValue(raw: unknown): string {
  if (typeof raw === 'string') return redactString(raw);
  if (raw === undefined) return 'undefined';
  if (raw === null) return 'null';
  if (
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint' ||
    typeof raw === 'symbol'
  ) {
    return String(raw);
  }
  try {
    const json = JSON.stringify(raw);
    if (json !== undefined) return json;
  } catch {
    // fall through to a stable non-contentful fallback
  }
  if (typeof raw === 'function') return raw.name === '' ? '[Function]' : `[Function: ${raw.name}]`;
  return Object.prototype.toString.call(raw);
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of RAW_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function formatPair(key: string, raw: unknown): string {
  const limited = truncate(serializeValue(raw), CTX_VALUE_MAX_CHARS);
  const renderedKey = SAFE_KEY_RE.test(key) ? key : quote(key);
  const renderedVal = /[\s="\\]/.test(limited) || limited.length === 0 ? quote(limited) : limited;
  return `${renderedKey}=${renderedVal}`;
}

function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  // Binary-search the longest prefix that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (
      Buffer.byteLength(text.slice(0, mid), 'utf-8') <=
      maxBytes - Buffer.byteLength(TRUNCATED_TAIL, 'utf-8')
    ) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + TRUNCATED_TAIL;
}

function clipStack(stack: string): string {
  if (Buffer.byteLength(stack, 'utf-8') <= STACK_MAX_BYTES) return stack;
  return clipBytes(stack, STACK_MAX_BYTES);
}

function indentStack(stack: string): string {
  return stack
    .split('\n')
    .map((line, i) => (i === 0 ? `  ${line}` : `    ${line.trimStart()}`))
    .join('\n');
}

export function formatEntry(entry: LogEntry, options: FormatOptions = {}): FormattedEntry {
  const ctx = entry.ctx ? redactCtx(entry.ctx) : undefined;
  const omitContextKeys = new Set(options.omitContextKeys ?? []);
  const msg = truncate(entry.msg, MSG_MAX_CHARS);
  const pairs: string[] = [];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (omitContextKeys.has(k)) continue;
      if (v !== undefined) pairs.push(formatPair(k, v));
    }
  }

  const time = new Date(entry.t).toISOString();
  const label = LEVEL_LABEL[entry.level];
  const rendered = pairs.length === 0
    ? `${time} ${label} ${msg}`
    : `${time} ${label} ${msg}  ${pairs.join(' ')}`;

  let head = Buffer.byteLength(rendered, 'utf-8') > ENTRY_MAX_BYTES
    ? clipBytes(rendered, ENTRY_MAX_BYTES)
    : rendered;

  if (options.ansi === true) {
    head = `${ANSI_LEVEL[entry.level]}${head}${ANSI_RESET}`;
  }

  if (entry.error?.stack) {
    head = `${head}\n${indentStack(clipStack(redactString(entry.error.stack)))}`;
  } else if (entry.error?.message) {
    head = `${head}\n  Error: ${redactString(entry.error.message)}`;
  }

  return { text: head, dropped: false };
}

export function extractError(value: Error): { message: string; stack?: string } {
  return typeof value.stack === 'string'
    ? { message: value.message, stack: value.stack }
    : { message: value.message };
}

/* ------------------------------------------------------------------ */
/*  Rotating file sink (port of `agent-core/src/logging/sinks.ts`)     */
/* ------------------------------------------------------------------ */

export const PENDING_MAX = 1000;
const STDERR_NOTICE_INTERVAL_MS = 30_000;

class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    // Swallow rejection on the tail to prevent unhandled rejection in the
    // serial chain — the actual error surfaces through the returned `next`
    // promise which the caller awaits.
    this.tail = next.catch(() => { /* intentional — serial queue tail guard */ });
    return next;
  }
}
export interface Sink {
  enqueue(line: string): void;
  /** Resolves to false when the pending batch could not be written. */
  flush(): Promise<boolean>;
  close(): Promise<void>;
  flushSync(): void;
}

interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly files: number;
}

export class RotatingFileSink implements Sink {
  private readonly queue = new AsyncSerialQueue();
  private pending: string[] = [];
  private dropped = 0;
  private closed = false;
  private lastStderrNotice = 0;
  private currentBytes = -1;
  private directorySynced = false;
  /** Lines taken from `pending` by `drain()` but not yet confirmed written.
   *  `flushSync()` uses this to avoid losing the last batch when the process
   *  exits while an async drain is in flight (the event loop stops, so the
   *  drain's pending `await`s never resume). */
  private inFlight: string[] | undefined;

  constructor(private readonly options: RotatingFileSinkOptions) {}

  enqueue(line: string): void {
    if (this.closed) return;
    if (this.pending.length >= PENDING_MAX) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(line);
    this.scheduleDrain();
  }

  async flush(): Promise<boolean> {
    return this.queue.run(() => this.drain());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } catch {
      // swallow — close must not throw
    }
  }

  flushSync(): void {
    if (this.closed) return;
    const hasPending = this.pending.length > 0;
    const hasInFlight = this.inFlight !== undefined && this.inFlight.length > 0;
    if (!hasPending && !hasInFlight) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const parts: string[] = [];
      // In-flight lines may have been partially written by the async drain —
      // duplicate lines are preferable to data loss on exit.
      if (hasInFlight) parts.push(this.inFlight!.join(''));
      if (hasPending) {
        parts.push(this.pending.join(''));
        parts.push(this.takeDroppedNotice());
      }
      this.pending = [];
      this.inFlight = undefined;
      appendFileSync(this.options.path, parts.join(''));
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed || this.pending.length === 0) return;
      this.queue.run(() => this.drain()).catch(() => {});
    });
  }

  private async drain(): Promise<boolean> {
    if (this.pending.length === 0) return true;
    const droppedLine = this.takeDroppedNotice();
    const lines = droppedLine === '' ? [...this.pending] : [...this.pending, droppedLine];
    this.pending = [];
    this.inFlight = lines;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      if (this.currentBytes < 0) {
        this.currentBytes = await this.statSize(this.options.path);
      }
      await this.appendLines(lines);

      if (!this.directorySynced) {
        await syncDir(dirname(this.options.path));
        this.directorySynced = true;
      }

      this.inFlight = undefined;
      return true;
    } catch (error) {
      this.noteFailure(error);
      this.inFlight = undefined;
      this.restorePending(lines);
      return false;
    }
  }

  private restorePending(lines: readonly string[]): void {
    const restored = [...lines, ...this.pending];
    const overflow = restored.length - PENDING_MAX;
    if (overflow <= 0) {
      this.pending = restored;
      return;
    }
    this.dropped += overflow;
    this.pending = restored.slice(overflow);
  }

  private async appendLines(lines: readonly string[]): Promise<void> {
    let chunk = '';
    let chunkBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (
        chunkBytes > 0 &&
        (chunkBytes + lineBytes > this.options.maxBytes ||
          this.currentBytes + chunkBytes + lineBytes > this.options.maxBytes)
      ) {
        await this.appendChunk(chunk);
        chunk = '';
        chunkBytes = 0;
      }

      if (
        chunkBytes === 0 &&
        this.currentBytes > 0 &&
        this.currentBytes + lineBytes > this.options.maxBytes
      ) {
        await this.rotate();
      }

      chunk += line;
      chunkBytes += lineBytes;
    }
    if (chunkBytes > 0) {
      await this.appendChunk(chunk);
    }
  }

  private async appendChunk(chunk: string): Promise<void> {
    const fh = await open(this.options.path, 'a');
    try {
      await fh.appendFile(chunk, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.currentBytes += Buffer.byteLength(chunk, 'utf-8');
    if (this.currentBytes >= this.options.maxBytes) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    const { path, files } = this.options;
    for (let i = files - 2; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      try {
        await rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await rename(path, `${path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // last archive may be evicted; ensure we don't keep > files
    try {
      await unlink(`${path}.${files}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.currentBytes = 0;
    this.directorySynced = false;
  }

  private async statSize(p: string): Promise<number> {
    try {
      const s = await stat(p);
      return s.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private takeDroppedNotice(): string {
    if (this.dropped === 0) return '';
    const line = `... dropped ${this.dropped} entries ...\n`;
    this.dropped = 0;
    return line;
  }

  private noteFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastStderrNotice < STDERR_NOTICE_INTERVAL_MS) return;
    this.lastStderrNotice = now;
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    try {
      process.stderr.write(`[logger] write failed: ${code}\n`);
    } catch {
      // stderr itself is unavailable — nothing left to fall back on.
    }
  }
}

function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const fd = openSync(dirPath, 'r');
    try {
      fsyncSync(fd);
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      closeSync(fd);
    }
  });
}
