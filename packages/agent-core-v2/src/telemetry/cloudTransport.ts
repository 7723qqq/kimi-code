/**
 * `telemetry` domain (L1) — `CloudTransport`, the HTTP transport behind
 * `CloudSink`. Posts enriched events to the telemetry endpoint with Bearer
 * auth, retry, and on-disk fallback for failed events. Core-scoped; has no
 * cross-domain collaborators and is independent of `@moonshot-ai/kimi-telemetry`.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type CloudPrimitive = boolean | number | string | undefined | null;

export type CloudProperties = Record<string, CloudPrimitive>;

export type CloudContext = Record<string, CloudPrimitive>;

export interface CloudEvent {
  readonly event_id: string;
  device_id: string | null;
  session_id: string | null;
  readonly event: string;
  readonly timestamp: number;
  readonly properties: CloudProperties;
}

export interface EnrichedCloudEvent extends CloudEvent {
  readonly context: CloudContext;
}

export interface CloudPayload {
  readonly user_id: string;
  readonly events: readonly Record<string, CloudPrimitive>[];
}

export interface CloudTransportOptions {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly endpoint?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export const TELEMETRY_ENDPOINT = 'https://telemetry-logs.kimi.com/v1/event';
export const SERVER_EVENT_PREFIX = 'kfc_';
export const USER_ID_PREFIX = 'kfc_device_id_';
export const DISK_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class CloudTransport {
  private readonly homeDir: string;
  private readonly deviceId: string;
  private readonly endpoint: string;
  private readonly getAccessToken: (() => string | null | Promise<string | null>) | null;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffsMs: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: CloudTransportOptions) {
    this.homeDir = options.homeDir;
    this.deviceId = options.deviceId;
    this.endpoint = options.endpoint ?? TELEMETRY_ENDPOINT;
    this.getAccessToken = options.getAccessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffsMs = options.retryBackoffsMs ?? RETRY_BACKOFFS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleepImpl = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  async send(events: readonly EnrichedCloudEvent[], signal?: AbortSignal): Promise<void> {
    if (events.length === 0) return;
    let savedToDisk = false;
    const saveEventsToDisk = (): void => {
      if (savedToDisk) return;
      this.saveToDisk(events);
      savedToDisk = true;
    };
    if (signal?.aborted === true) {
      saveEventsToDisk();
      throw abortError();
    }

    let payload: CloudPayload;
    try {
      payload = buildPayload(events, this.deviceId);
    } catch {
      return;
    }

    try {
      for (let attempt = 0; attempt <= this.retryBackoffsMs.length; attempt++) {
        try {
          await this.sendHttp(payload, signal);
          return;
        } catch (error) {
          if (isSignalAborted(signal) || isAbortError(error)) {
            saveEventsToDisk();
            throw error;
          }
          if (!(error instanceof TransientCloudError)) {
            break;
          }
          const backoff = this.retryBackoffsMs[attempt];
          if (backoff === undefined) break;
          await this.sleepImpl(backoff, signal);
        }
      }
    } catch (error) {
      if (isSignalAborted(signal) || isAbortError(error)) {
        saveEventsToDisk();
        throw error;
      }
    }

    saveEventsToDisk();
  }

  saveToDisk(events: readonly EnrichedCloudEvent[]): void {
    if (events.length === 0) return;
    const path = join(this.telemetryDir(), `failed_${randomBytes(6).toString('hex')}.jsonl`);
    const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort on platforms that do not support chmod.
    }
  }

  async retryDiskEvents(): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(this.telemetryDir());
    } catch {
      return;
    }

    const now = this.now();
    for (const entry of entries) {
      if (!entry.startsWith('failed_') || !entry.endsWith('.jsonl')) continue;
      const path = join(this.telemetryDir(), entry);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs > DISK_EVENT_MAX_AGE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue;
      }

      let events: EnrichedCloudEvent[];
      let payload: CloudPayload;
      try {
        events = readJsonl(path);
        payload = buildPayload(events, this.deviceId);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          try {
            unlinkSync(path);
          } catch {
            // best effort cleanup.
          }
        }
        continue;
      }

      try {
        await this.sendHttp(payload);
        unlinkSync(path);
      } catch (error) {
        if (error instanceof TransientCloudError) continue;
      }
    }
  }

  private async sendHttp(payload: CloudPayload, signal?: AbortSignal): Promise<void> {
    const token = this.getAccessToken === null ? null : await this.getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token !== null && token.length > 0) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await this.post(payload, headers, signal);
    if (response.status === 401 && headers['Authorization'] !== undefined) {
      delete headers['Authorization'];
      const retry = await this.post(payload, headers, signal);
      handleStatus(retry.status);
      return;
    }
    handleStatus(response.status);
  }

  private async post(
    payload: CloudPayload,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(
        this.fetchImpl,
        this.endpoint,
        {
          method: 'POST',
          headers: { ...headers },
          body: JSON.stringify(payload),
        },
        this.requestTimeoutMs,
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      throw new TransientCloudError(String(error));
    }
  }

  private telemetryDir(): string {
    const path = join(this.homeDir, 'telemetry');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      chmodSync(path, 0o700);
    } catch {
      // best effort on platforms that do not support chmod.
    }
    return path;
  }
}

export class TransientCloudError extends Error {
  override readonly name = 'TransientCloudError';
}

export function buildUserId(deviceId: string): string {
  return USER_ID_PREFIX + deviceId;
}

export function buildPayload(
  events: readonly EnrichedCloudEvent[],
  deviceId: string,
): CloudPayload {
  return {
    user_id: buildUserId(deviceId),
    events: events.map((event) => flattenEvent(applyServerPrefix(event))),
  };
}

export function applyServerPrefix(event: EnrichedCloudEvent): EnrichedCloudEvent {
  const name: unknown = event.event;
  if (typeof name !== 'string' || name.length === 0 || name.startsWith(SERVER_EVENT_PREFIX)) {
    return event;
  }
  return { ...event, event: SERVER_EVENT_PREFIX + name };
}

export function flattenEvent(event: EnrichedCloudEvent): Record<string, CloudPrimitive> {
  const out: Record<string, CloudPrimitive> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'properties') {
      flattenNested(out, 'property', value);
    } else if (key === 'context') {
      flattenNested(out, 'context', value);
    } else {
      assertPrimitive(key, value);
      out[key] = value;
    }
  }
  return out;
}

export function isCloudPrimitive(value: unknown): value is CloudPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function flattenNested(target: Record<string, CloudPrimitive>, prefix: string, value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    assertPrimitive(`${prefix}.${key}`, nestedValue);
    target[`${prefix}_${key}`] = nestedValue;
  }
}

function assertPrimitive(key: string, value: unknown): asserts value is CloudPrimitive {
  if (isCloudPrimitive(value)) return;
  throw new TypeError(`telemetry ${key} must be primitive`);
}

function handleStatus(status: number): void {
  if (status >= 500 || status === 429) {
    throw new TransientCloudError(`HTTP ${String(status)}`);
  }
  if (status >= 400) {
    return;
  }
}

function readJsonl(path: string): EnrichedCloudEvent[] {
  const text = readFileSync(path, 'utf-8');
  const events: EnrichedCloudEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(JSON.parse(trimmed) as EnrichedCloudEvent);
  }
  return events;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    controller.abort(new Error('telemetry request timed out'));
  }, timeoutMs);
  timeout.unref?.();
  if (externalSignal?.aborted === true) abortFromExternal();
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
