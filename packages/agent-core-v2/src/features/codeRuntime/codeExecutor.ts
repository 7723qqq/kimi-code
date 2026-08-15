/**
 * `codeRuntime` domain — the host-side worker orchestrator.
 *
 * Spawns one eval-mode worker per run (no state survives between runs),
 * streams captured log lines, races the completion against the timeout and
 * the caller's abort signal, and always settles with a structured outcome —
 * the only failures are worker-substrate deaths, reported as `worker-error`.
 */

import { Worker } from 'node:worker_threads';

import type { CodeRunOutcome } from './codeRuntime';
import { CODE_WORKER_SOURCE } from './codeWorkerSource';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export interface CodeRunOptions {
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
}

interface WorkerDoneMessage {
  readonly type: 'done';
  readonly value?: unknown;
  readonly error?: { readonly kind: string; readonly message: string };
}

interface WorkerLogMessage {
  readonly type: 'log';
  readonly text: string;
}

type WorkerHostMessage = WorkerDoneMessage | WorkerLogMessage;

function isHostMessage(message: unknown): message is WorkerHostMessage {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === 'log' || type === 'done';
}

/**
 * Run one program in a fresh worker thread.
 *
 * @param code - The program body; executed as a strict-mode async function.
 * @param options - Timeout budget (default 30s, capped at 120s), output
 *   character budget (default 100_000), and an optional abort signal.
 * @returns The structured outcome; never rejects for program failures.
 */
export async function runCodeInWorker(
  code: string,
  options: CodeRunOptions = {},
): Promise<CodeRunOutcome> {
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const worker = new Worker(CODE_WORKER_SOURCE, {
    eval: true,
    // Bound the worker's heap so a runaway program cannot exhaust the host
    // process memory before the timeout fires. The worker is a soft
    // isolation boundary, but an OOM here would take the whole agent down.
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 4,
    },
  });

  return new Promise<CodeRunOutcome>((resolve) => {
    const logs: string[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      options.signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };

    const settle = (outcome: CodeRunOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      resolve(outcome);
    };

    const onAbort = (): void => {
      settle({
        logs: [...logs],
        error: { kind: 'cancelled', message: 'code run cancelled' },
      });
    };

    const onMessage = (message: unknown): void => {
      if (!isHostMessage(message)) return;
      if (message.type === 'log') {
        logs.push(message.text);
        return;
      }
      settle({
        logs: [...logs],
        ...(message.value !== undefined ? { value: message.value } : {}),
        ...(message.error !== undefined ? { error: message.error } : {}),
      });
    };

    const onError = (error: Error): void => {
      settle({
        logs: [...logs],
        error: {
          kind: 'worker-error',
          message: error.message.length > 0 ? error.message : String(error),
        },
      });
    };

    // A program that calls process.exit() (or closes its parent port) drops
    // the worker without a `done` message; without this the host would sit
    // idle until the full timeout instead of reporting the exit immediately.
    const onExit = (exitCode: number | null): void => {
      if (settled) return;
      settle({
        logs: [...logs],
        error: {
          kind: 'worker-exit',
          message:
            exitCode === null
              ? 'worker terminated by signal without reporting a result'
              : `worker exited with code ${String(exitCode)} without reporting a result`,
        },
      });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      settle({
        logs: [...logs],
        error: { kind: 'timeout', message: `program did not finish within ${timeoutMs}ms` },
      });
    }, timeoutMs);
    worker.postMessage({ type: 'run', code, maxOutputChars });
  });
}
