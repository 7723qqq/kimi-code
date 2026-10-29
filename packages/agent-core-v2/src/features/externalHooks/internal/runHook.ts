import { type SpawnOptionsWithoutStdio } from 'node:child_process';

import { z } from 'zod';

import { errorMessage } from '#/_base/utils/errorMessage';
import { isRecord } from '#/_base/utils/guards';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { type IHostProcess } from '#/os/interface/hostProcess';

import type { HookResult } from './types';

export interface RunHookOptions {
  readonly timeout: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly failClosed?: boolean;
}

export function buildHookSpawnOptions(options: {
  cwd?: string;
  env?: Record<string, string>;
}): SpawnOptionsWithoutStdio {
  return {
    shell: true,
    cwd: options.cwd,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
  };
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const KILL_GRACE_MS = 100;
const MAX_HOOK_OUTPUT_CHARS = 64 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n[hook output truncated]';

function appendCapped(current: string, chunk: string): { text: string; truncated: boolean } {
  const remaining = MAX_HOOK_OUTPUT_CHARS - current.length;
  if (remaining <= 0) {
    if (chunk.length === 0) return { text: current, truncated: false };
    const text = current.endsWith(OUTPUT_TRUNCATED_MARKER)
      ? current
      : current + OUTPUT_TRUNCATED_MARKER;
    return { text, truncated: true };
  }
  if (chunk.length <= remaining) return { text: current + chunk, truncated: false };
  return { text: current + chunk.slice(0, remaining) + OUTPUT_TRUNCATED_MARKER, truncated: true };
}

const OptionalStringSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}, z.string().optional());
const HookSpecificOutputSchema = z.preprocess(
  (value) => (isRecord(value) ? value : undefined),
  z
    .looseObject({
      message: OptionalStringSchema,
      permissionDecision: z.unknown().optional(),
      permissionDecisionReason: z.unknown().optional(),
    })
    .optional(),
);
const HookJsonOutputSchema = z.looseObject({
  message: OptionalStringSchema,
  hookSpecificOutput: HookSpecificOutputSchema,
});

export async function runHook(
  hostProcess: IHostProcessService,
  command: string,
  input: Record<string, unknown>,
  options: RunHookOptions,
): Promise<HookResult> {
  let proc: IHostProcess;
  try {
    proc = await hostProcess.spawn(command, [], {
      shell: true,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    return options.failClosed === true
      ? blockResult(
          `Permission hook failed to spawn: ${errorMessage(error)}`,
          undefined,
          errorMessage(error),
        )
      : allowResult({ stderr: errorMessage(error), errored: true });
  }

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    const timeoutMs = timeoutSeconds(options.timeout) * 1000;

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      const appended = appendCapped(stdout, chunk);
      stdout = appended.text;
      truncated ||= appended.truncated;
    });
    proc.stderr.on('data', (chunk: string) => {
      const appended = appendCapped(stderr, chunk);
      stderr = appended.text;
      truncated ||= appended.truncated;
    });

    const stdoutDone = new Promise<void>((done) => proc.stdout.once('end', done));
    const stderrDone = new Promise<void>((done) => proc.stderr.once('end', done));
    void Promise.all([proc.wait(), stdoutDone, stderrDone]).then(
      ([code]) => {
        void proc.dispose();
        settle(resultFromExitCode(code, stdout, stderr, truncated));
      },
      (error) => {
        void proc.dispose();
        const failureStderr = stderr + errorMessage(error);
        if (options.failClosed === true) {
          settle(
            blockResult(
              'Permission hook errored while running',
              undefined,
              failureStderr,
              truncated,
            ),
          );
          return;
        }
        settle(
          allowResult({
            stdout,
            stderr: failureStderr,
            errored: true,
            outputTruncated: truncated,
          }),
        );
      },
    );

    const timeout = setTimeout(() => {
      killProcess(proc);
      if (options.failClosed === true) {
        settle(
          blockResult(
            'Permission hook timed out',
            undefined,
            `${stderr} (timed out)`,
            truncated,
          ),
        );
        return;
      }
      settle(allowResult({ stdout, stderr, timedOut: true, outputTruncated: truncated }));
    }, timeoutMs);

    const onAbort = (): void => {
      killProcess(proc);
      settle(allowResult({ stdout, stderr, outputTruncated: truncated }));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
  });
}

function timeoutSeconds(timeout: number): number {
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
}

function resultFromExitCode(
  exitCode: number,
  stdout: string,
  stderr: string,
  outputTruncated: boolean,
): HookResult {
  if (exitCode === 2) {
    const message = stderr.trim();
    return {
      action: 'block',
      message,
      reason: message,
      stdout,
      stderr,
      exitCode,
      outputTruncated,
    };
  }

  const structured = exitCode === 0 ? structuredOutput(stdout) : undefined;
  if (structured?.action === 'block') {
    return {
      action: 'block',
      message: structured.message ?? structured.reason,
      reason: structured.reason,
      stdout,
      stderr,
      exitCode,
      structuredOutput: structured.structuredOutput,
      outputTruncated,
    };
  }

  return allowResult({
    message: structured?.message,
    stdout,
    stderr,
    exitCode,
    structuredOutput: structured?.structuredOutput,
    outputTruncated,
  });
}

function structuredOutput(
  stdout: string,
): { action?: 'block'; reason?: string; message?: string; structuredOutput: true } | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    const output = HookJsonOutputSchema.safeParse(parsed);
    if (!output.success) return undefined;

    const { message, hookSpecificOutput } = output.data;
    const result = {
      message: message ?? hookSpecificOutput?.message,
      structuredOutput: true as const,
    };
    if (hookSpecificOutput?.permissionDecision !== 'deny') {
      return result;
    }
    return {
      action: 'block',
      message: result.message,
      reason:
        typeof hookSpecificOutput.permissionDecisionReason === 'string'
          ? hookSpecificOutput.permissionDecisionReason
          : undefined,
      structuredOutput: true as const,
    };
  } catch {
    return undefined;
  }
}

function allowResult(input: {
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly errored?: boolean;
  readonly structuredOutput?: boolean;
  readonly outputTruncated?: boolean;
}): HookResult {
  return {
    action: 'allow',
    message: input.message,
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    errored: input.errored,
    structuredOutput: input.structuredOutput,
    outputTruncated: input.outputTruncated,
  };
}

function killProcess(proc: IHostProcess): void {
  void proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    void proc.kill('SIGKILL');
  }, KILL_GRACE_MS);
  killTimer.unref();
}


function blockResult(
  reason: string,
  stdout: string | undefined,
  stderr: string | undefined,
  outputTruncated?: boolean,
): HookResult {
  return {
    action: 'block',
    message: reason,
    reason,
    stdout,
    stderr,
    outputTruncated,
  };
}

