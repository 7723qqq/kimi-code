import type { CodeRunOutcome } from './codeRuntime';
import { CODE_SHIM_SOURCE, CODE_SHIM_SUBCOMMAND } from './codeShimSource';
import { MEMORY_CAP_BYTES, MemoryCapUnavailableError, createMemoryGuard, type MemoryGuard } from './memoryGuard';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const WINDOWS_MEMORY_ATTRIBUTION_RATIO = 0.9;
const STDERR_CAPTURE_CHARS = 4_096;
const RAW_OUTPUT_CEILING_CHARS = DEFAULT_MAX_OUTPUT_CHARS * 4;

export interface CodeRunOptions {
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
}

interface ShimError {
  readonly kind: string;
  readonly message: string;
}

function shimSpawnCommand(): readonly string[] {
  const assets = (globalThis as { __KIMI_BUN_ASSETS__?: Record<string, unknown> })
    .__KIMI_BUN_ASSETS__;
  if (assets !== undefined && Object.keys(assets).length > 0) {
    return [process.execPath, CODE_SHIM_SUBCOMMAND];
  }
  return [process.execPath, '-e', `${CODE_SHIM_SOURCE}(require, process)`];
}

function normalizeShimError(error: unknown): ShimError {
  if (typeof error === 'object' && error !== null) {
    const kind = (error as { kind?: unknown }).kind;
    const message = (error as { message?: unknown }).message;
    if (typeof kind === 'string' && typeof message === 'string') {
      return { kind, message };
    }
  }
  return { kind: 'worker-error', message: 'code subprocess reported a malformed error' };
}

async function captureStderr(
  stream: ReadableStream<Uint8Array>,
  sink: { text: string },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (sink.text.length < STDERR_CAPTURE_CHARS) {
        sink.text += decoder.decode(value, { stream: true });
        if (sink.text.length > STDERR_CAPTURE_CHARS) {
          sink.text = sink.text.slice(0, STDERR_CAPTURE_CHARS);
        }
      }
    }
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

export async function runCodeInSubprocess(
  code: string,
  options: CodeRunOptions = {},
): Promise<CodeRunOutcome> {
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn({
      cmd: [...shimSpawnCommand()],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    return {
      logs: [],
      error: {
        kind: 'worker-error',
        message: `failed to spawn code subprocess: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const killChild = (): void => {
    try {
      proc.kill();
    } catch (killError) {
      void killError;
    }
  };

  let guard: MemoryGuard | undefined;
  try {
    guard = createMemoryGuard(proc.pid, MEMORY_CAP_BYTES, killChild);
  } catch (error) {
    if (proc.exitCode === null) {
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolveRace) => {
          setTimeout(() => resolveRace(false), 500);
        }),
      ]);
      if (!exited) {
        killChild();
        await proc.exited.catch(() => 0);
        const reason =
          error instanceof MemoryCapUnavailableError
            ? error.message
            : `memory cap setup failed: ${error instanceof Error ? error.message : String(error)}`;
        return {
          logs: [],
          error: {
            kind: 'sandbox-unavailable',
            message: `refusing to run without memory enforcement: ${reason}`,
          },
        };
      }
    }
    guard = undefined;
  }

  return new Promise<CodeRunOutcome>((resolve) => {
    const logs: string[] = [];
    const stderrSink = { text: '' };
    let settled = false;
    let rawChars = 0;
    let rawLimitHit = false;
    const timer = setTimeout(() => {
      settle({
        logs: [...logs],
        error: { kind: 'timeout', message: `program did not finish within ${timeoutMs}ms` },
      });
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      guard?.dispose();
      killChild();
    };

    const settle = (outcome: CodeRunOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const onAbort = (): void => {
      settle({
        logs: [...logs],
        error: { kind: 'cancelled', message: 'code run cancelled' },
      });
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        logs.push(trimmed);
        return;
      }
      if (typeof message !== 'object' || message === null) {
        logs.push(trimmed);
        return;
      }
      const type = (message as { type?: unknown }).type;
      if (type === 'log') {
        const text = (message as { text?: unknown }).text;
        if (typeof text === 'string') logs.push(text);
        return;
      }
      if (type === 'done') {
        const value = (message as { value?: unknown }).value;
        const error = (message as { error?: unknown }).error;
        settle({
          logs: [...logs],
          ...(value !== undefined ? { value } : {}),
          ...(error !== undefined ? { error: normalizeShimError(error) } : {}),
        });
        return;
      }
      logs.push(trimmed);
    };

    const readStdout = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rawChars += value.byteLength;
          if (rawChars > RAW_OUTPUT_CEILING_CHARS && !rawLimitHit) {
            rawLimitHit = true;
            killChild();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            handleLine(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) handleLine(buffer);
      } catch {
        return;
      } finally {
        reader.releaseLock();
      }
    };

    const memoryLimitOutcome = (): CodeRunOutcome => ({
      logs: [...logs],
      error: {
        kind: 'memory-limit',
        message: 'program exceeded the memory budget and was terminated',
      },
    });

    const onExited = (exitCode: number): void => {
      if (settled) return;
      if (rawLimitHit) {
        settle({
          logs: [...logs],
          error: { kind: 'output-limit', message: 'program output exceeded the size limit' },
        });
        return;
      }
      if (guard?.exceeded() === true) {
        settle(memoryLimitOutcome());
        return;
      }
      const peak = guard?.peakBytes();
      if (peak !== undefined && peak >= MEMORY_CAP_BYTES * WINDOWS_MEMORY_ATTRIBUTION_RATIO) {
        settle(memoryLimitOutcome());
        return;
      }
      const stderrNote =
        stderrSink.text.trim().length > 0 ? `: ${stderrSink.text.trim().slice(-500)}` : '';
      settle({
        logs: [...logs],
        error: {
          kind: 'worker-exit',
          message: `code subprocess exited with code ${String(exitCode)} without reporting a result${stderrNote}`,
        },
      });
    };

    void readStdout();
    void captureStderr(proc.stderr, stderrSink);
    void proc.exited.then(onExited);

    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      void Promise.resolve(
        proc.stdin.write(JSON.stringify({ code, maxOutputChars, timeoutMs })),
      )
        .then(() => proc.stdin.end())
        .catch(() => {});
    } catch {
      killChild();
    }
  });
}
