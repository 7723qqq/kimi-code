/**
 * `telemetry` domain (L1) — `CloudAppender`, an `ITelemetryAppender` that
 * batches events, enriches them with common context, and posts them to the
 * telemetry endpoint through `CloudTransport`, which persists failed events
 * through the `storage` byte layer. Core-scoped; independent of
 * `@moonshot-ai/kimi-telemetry`.
 */

import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';

import type { IStorageService } from '#/storage';

import type { ITelemetryAppender, TelemetryContextPatch, TelemetryProperties } from './telemetry';
import {
  type CloudContext,
  type CloudPrimitive,
  type CloudProperties,
  CloudTransport,
  type EnrichedCloudEvent,
  isCloudPrimitive,
} from './cloudTransport';

export interface CloudAppenderOptions {
  readonly storage: IStorageService;
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly appName: string;
  readonly version: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly endpoint?: string;
  readonly flushThreshold?: number;
  readonly flushIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly env: NodeJS.ProcessEnv;
}

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export class CloudAppender implements ITelemetryAppender {
  private readonly transport: CloudTransport;
  private readonly context: CloudContext;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private deviceId: string;
  private sessionId: string | null;
  private buffer: EnrichedCloudEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CloudAppenderOptions) {
    this.deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? null;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.context = buildContext(options);
    this.transport = new CloudTransport({
      storage: options.storage,
      deviceId: options.deviceId,
      endpoint: options.endpoint,
      getAccessToken: options.getAccessToken,
      fetchImpl: options.fetchImpl,
      retryBackoffsMs: options.retryBackoffsMs,
      requestTimeoutMs: options.requestTimeoutMs,
      sleep: options.sleep,
      now: options.now,
    });
  }

  track(event: string, properties?: TelemetryProperties): void {
    const enriched: EnrichedCloudEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id: this.sessionId,
      event,
      timestamp: Date.now() / 1000,
      properties: sanitizeProperties(properties),
      context: { ...this.context },
    };
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  setContext(patch: TelemetryContextPatch): void {
    const deviceId = patch['deviceId'];
    if (typeof deviceId === 'string') {
      this.deviceId = deviceId;
    }
    const sessionId = patch['sessionId'];
    if (typeof sessionId === 'string') {
      this.sessionId = sessionId;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    await this.transport.send(events);
  }

  async shutdown(): Promise<void> {
    this.stopPeriodicFlush();
    await this.flush();
  }

  startPeriodicFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  async retryDiskEvents(): Promise<void> {
    await this.transport.retryDiskEvents();
  }
}

function sanitizeProperties(input?: TelemetryProperties): CloudProperties {
  const out: CloudProperties = {};
  if (input === undefined) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isCloudPrimitive(value)) {
      out[key] = value;
    }
  }
  return out;
}

function buildContext(options: CloudAppenderOptions): CloudContext {
  const env = options.env;
  const context: CloudContext = {
    app_name: options.appName,
    version: options.version,
    runtime: 'node',
    platform: platform(),
    arch: arch(),
    node_version: process.versions.node,
    os_version: release(),
    ci: env['CI'] !== undefined,
    locale: options.locale ?? env['LANG'] ?? '',
    terminal: options.terminal ?? env['TERM_PROGRAM'] ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  return context;
}

function setPrimitive(target: CloudContext, key: string, value: CloudPrimitive): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}
