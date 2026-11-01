import { abortable } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

export interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function retryBackoffDelay(attemptIndex: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, attemptIndex), MAX_DELAY_MS);
  return base + Math.random() * JITTER_FACTOR * base;
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    delays.push(retryBackoffDelay(i));
  }
  return delays;
}

export function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

export interface RetrySleepTimers {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
}

export async function sleepForRetry(
  delayMs: number,
  signal?: AbortSignal,
  timers?: RetrySleepTimers,
): Promise<void> {
  signal?.throwIfAborted();
  const sleepPromise = sleep(delayMs, timers);
  if (signal === undefined) {
    await sleepPromise;
    return;
  }
  await abortable(sleepPromise, signal);
}

export function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: messageWithCause(error),
    statusCode: maybeStatusCode(error),
  };
}

const MAX_CAUSE_DEPTH = 3;

function messageWithCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = describeCauseChain(error, message);
  if (cause === undefined) return message;
  return message.length === 0 ? cause : `${message} (${cause})`;
}

function describeCauseChain(error: unknown, message: string): string | undefined {
  const parts: string[] = [];
  let current = causeOf(error);
  while (parts.length < MAX_CAUSE_DEPTH && current !== undefined && current !== null) {
    const part = describeCause(current);
    if (part !== undefined && !message.includes(part.message) && !parts.includes(part.text)) {
      parts.push(part.text);
    }
    current = causeOf(current);
  }
  return parts.length === 0 ? undefined : parts.join('; ');
}

function causeOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { cause?: unknown }).cause;
}

function describeCause(
  value: unknown,
): { readonly text: string; readonly message: string } | undefined {
  if (!(value instanceof Error)) {
    const text = String(value);
    return text.length === 0 ? undefined : { text, message: text };
  }
  if (value.message.length === 0) return undefined;
  const code = (value as { code?: unknown }).code;
  return {
    text:
      typeof code === 'string' && code.length > 0
        ? `${code}: ${value.message}`
        : `${value.name}: ${value.message}`,
    message: value.message,
  };
}

function sleep(delayMs: number, timers?: RetrySleepTimers): Promise<void> {
  return new Promise((resolve) => {
    if (timers === undefined) {
      setTimeout(resolve, delayMs);
      return;
    }
    timers.setTimeout(resolve, delayMs);
  });
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const details = (error as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const detailsStatus = (details as { statusCode?: unknown }).statusCode;
    if (typeof detailsStatus === 'number') return detailsStatus;
  }
  return undefined;
}
